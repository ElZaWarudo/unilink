import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { access } from 'node:fs/promises';
import { SpeechService } from '../src/speech-service.js';

function fakeWorker() {
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    messages.push(JSON.parse(chunk.toString())); done();
  } });
  child.kill = () => child.emit('close', 0);
  return { child, messages, reply(message) { child.stdout.write(JSON.stringify(message) + '\n'); } };
}
const input = { mediaUrl: 'http://127.0.0.1:1/media?instance=x&version=1', subtitles: 'WEBVTT', audioIndex: 0, start: 0, duration: 120 };
const paths = { python: 'python', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', model: '/model' };
const flush = () => new Promise(resolve => setTimeout(resolve, 10));
async function sent(worker, count) {
  for (let i=0;i<100 && worker.messages.length<count;i++) await flush();
  assert.equal(worker.messages.length,count);
}

test('persistent worker is shared by simultaneous and subsequent requests', async t => {
  const worker = fakeWorker(); let starts = 0;
  const service = new SpeechService({ paths, spawnImpl: () => { starts++; return worker.child; } });
  t.after(() => service.close());
  const first = service.run(input, new AbortController().signal);
  const second = service.run({...input,start:60}, new AbortController().signal);
  await sent(worker,2);
  assert.equal(starts,1);
  worker.reply({type:'result',id:worker.messages.find(m=>m.input.start===60).id,state:'insufficient'});
  assert.equal((await second).state,'insufficient');
  worker.reply({type:'result',id:worker.messages.find(m=>m.input.start===0).id,state:'ready',result:{offset:1}});
  assert.equal((await first).state,'ready');
  const third = service.run(input,new AbortController().signal);
  await sent(worker,3);
  worker.reply({type:'result',id:worker.messages[2].id,state:'insufficient'});
  await third; assert.equal(starts,1);
});

test('cooperative cancellation keeps the worker available for the next request', async t => {
  const worker = fakeWorker();
  const service = new SpeechService({ paths, spawnImpl: () => worker.child });
  t.after(() => service.close());
  const cancel = new AbortController();
  const job = service.run(input,cancel.signal);
  await sent(worker,1); cancel.abort(); await sent(worker,2);
  assert.equal(worker.messages[1].type,'cancel');
  worker.reply({type:'result',id:worker.messages[0].id,state:'cancelled'});
  await assert.rejects(job,/cancelled/);
  assert.equal(service.pending.size,0);
  assert.equal(service.worker.child,worker.child);
});

test('a stuck cancellation retires the worker and a later request restarts it', async t => {
  const workers = [fakeWorker(),fakeWorker()]; let starts=0;
  const service = new SpeechService({paths,cancelGraceMs:10,spawnImpl:()=>workers[starts++].child});
  t.after(()=>service.close());
  const cancel = new AbortController();
  const job = service.run(input,cancel.signal);
  const rejected = assert.rejects(job,/stopped/);
  await sent(workers[0],1); cancel.abort(); await rejected;
  const next=service.run(input,new AbortController().signal);
  await sent(workers[1],1);
  workers[1].reply({type:'result',id:workers[1].messages[0].id,state:'insufficient'});
  await next; assert.equal(starts,2);
});

test('worker failure rejects both jobs and close prevents further launches', async () => {
  const worker=fakeWorker();
  const service=new SpeechService({paths,spawnImpl:()=>worker.child});
  const first=service.run(input,new AbortController().signal);
  const second=service.run(input,new AbortController().signal);
  const rejected=Promise.all([assert.rejects(first,/stopped/),assert.rejects(second,/stopped/)]);
  await sent(worker,2);
  await service.close(); await rejected;
  await assert.rejects(service.run(input,new AbortController().signal),/closed/);
  assert.equal(service.pending.size,0);
});

test('failed Windows taskkill retains the parent and temporary files until a successful tree-stop retry', async () => {
  const fake = fakeWorker();
  fake.child.pid = 12345;
  let fallbackCalls = 0, attempts = 0;
  fake.child.kill = () => { fallbackCalls++; return true; };
  const service = new SpeechService({ paths, spawnImpl: () => fake.child, platform: 'win32', stopTimeoutMs: 100,
    execFileImpl: (command, args, options, callback) => {
      assert.equal(command, 'taskkill');
      assert.deepEqual(args, ['/PID', '12345', '/T', '/F']);
      assert.equal(options.windowsHide, true);
      if (++attempts === 1) callback(new Error('taskkill failed'));
      else {
        callback(null);
        setImmediate(() => fake.child.emit('close', 0));
      }
    } });
  const worker = await service.ensureWorker();
  await assert.rejects(service.close(), /termination unconfirmed/);
  assert.equal(fallbackCalls, 0);
  assert.equal(service.worker, worker);
  await access(worker.directory);
  service.stopTimeoutMs = 1000;
  await service.close();
  assert.equal(attempts, 2);
  assert.equal(fallbackCalls, 0);
  await assert.rejects(access(worker.directory), { code: 'ENOENT' });
  assert.equal(service.worker, null);
});

test('a missing close event has a deadline, retains ownership and requires explicit retry', async () => {
  const fake = fakeWorker(); fake.child.pid = 12345;
  let starts = 0, attempts = 0, fallbackCalls = 0;
  fake.child.kill = () => { fallbackCalls++; return false; };
  const service = new SpeechService({ paths, spawnImpl: () => { starts++; return fake.child; },
    platform: 'win32', stopTimeoutMs: 30,
    execFileImpl: (_command, _args, _options, callback) => {
      attempts++;
      callback(null);
      if (attempts > 1) setImmediate(() => fake.child.emit('close', 0));
    } });
  const worker = await service.ensureWorker();
  const stopping = service.stop(worker);
  assert.equal(service.stop(worker), stopping);
  await assert.rejects(stopping, /termination unconfirmed/);
  assert.equal(fallbackCalls, 0);
  assert.equal(service.worker, worker);
  await access(worker.directory);
  await assert.rejects(service.ensureWorker(), /termination unconfirmed/);
  assert.equal(starts, 1);
  assert.equal(attempts, 1);
  service.stopTimeoutMs = 1000;
  await service.close();
  assert.equal(attempts, 2);
  assert.equal(service.worker, null);
  await assert.rejects(access(worker.directory), { code: 'ENOENT' });
});

test('protocol failure observes a background stop rejection and a hung taskkill never kills only the parent', async () => {
  const fake = fakeWorker(); fake.child.pid = 12345;
  let fallbackCalls = 0;
  fake.child.kill = () => { fallbackCalls++; throw new Error('kill failed'); };
  const service = new SpeechService({ paths, spawnImpl: () => fake.child, platform: 'win32',
    stopTimeoutMs: 30, execFileImpl: () => {} });
  const worker = await service.ensureWorker();
  fake.child.stdout.write('invalid protocol\n');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(fallbackCalls, 0);
  assert.match(worker.stopError.message, /termination unconfirmed/);
  assert.equal(service.worker, worker);
  fake.child.emit('close', 0);
  await service.close();
});
