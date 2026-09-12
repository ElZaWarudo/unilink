import { SpeechSetup } from "../src/speech-setup.js";

const setup = new SpeechSetup();
console.log(setup.start().message);
let lastMessage = "";
const progress = setInterval(async () => {
  const { message } = await setup.status();
  if (message !== lastMessage) { console.log(message); lastMessage = message; }
}, 1000);
process.once("SIGINT", () => setup.close());
process.once("SIGTERM", () => setup.close());
await setup.task;
clearInterval(progress);
const result = await setup.status();
console.log(result.message);
if (result.state !== "ready") process.exitCode = 1;
