// Private, synchronous JSON-lines worker. The Python owner bounds requests,
// kills this process on cancellation, and reloads it only when needed.
#include "whisper.h"
#include "ggml-backend.h"
#include "common-whisper.h"
#include "json.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;
static bool gpu_used = false, gpu_failed = false;

static void log_message(enum ggml_log_level, const char * text, void *) {
    const std::string message(text);
    if (message.find("whisper_backend_init_gpu: using Vulkan") != std::string::npos) gpu_used = true;
    if (message.find("whisper_backend_init_gpu: failed") != std::string::npos) gpu_failed = true;
    std::cerr << text;
}

static void reply(const json & value) {
    std::cout << value.dump(-1, ' ', false, json::error_handler_t::replace) << std::endl;
}

int main(int argc, char ** argv) {
    if (argc != 2) return 2;
    whisper_log_set(log_message, nullptr);
    std::string device;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        auto dev = ggml_backend_dev_get(i);
        auto type = ggml_backend_dev_type(dev);
        if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
            device = ggml_backend_dev_description(dev);
            break;
        }
    }
    if (device.empty()) { reply({{"state", "error"}, {"reason", "vulkan_unavailable"}}); return 1; }
    auto context_params = whisper_context_default_params();
    context_params.use_gpu = true;
    context_params.flash_attn = false; // Flash attention disables DTW in the pinned library.
    context_params.dtw_token_timestamps = true;
    context_params.dtw_aheads_preset = WHISPER_AHEADS_BASE_EN;
    std::unique_ptr<whisper_context, decltype(&whisper_free)> context(
        whisper_init_from_file_with_params(argv[1], context_params), whisper_free);
    if (!context || !gpu_used || gpu_failed) {
        reply({{"state", "error"}, {"reason", "vulkan_load_failed"}}); return 1;
    }
    reply({{"state", "ready"}, {"backend", "vulkan"}, {"device", device}, {"timing", "dtw"}});
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.size() > 16384) return 2;
        try {
            auto request = json::parse(line);
            if (!request.is_object() || !request.contains("path") || !request["path"].is_string()) {
                reply({{"state", "error"}}); continue;
            }
            std::vector<float> audio;
            std::vector<std::vector<float>> channels;
            if (!read_audio_data(request["path"].get<std::string>(), audio, channels, false) ||
                audio.empty() || audio.size() > 120 * WHISPER_SAMPLE_RATE) {
                reply({{"state", "error"}}); continue;
            }
            auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            params.n_threads = 2;
            params.language = "en";
            params.translate = false;
            params.no_context = true;
            params.no_timestamps = false;
            params.token_timestamps = true;
            params.print_special = params.print_progress = params.print_realtime = params.print_timestamps = false;
            params.temperature = 0;
            params.temperature_inc = 0;
            params.vad = false; // Preserve absolute sample time; matching rejects unreliable text.
            if (whisper_full(context.get(), params, audio.data(), static_cast<int>(audio.size())) != 0) {
                reply({{"state", "error"}}); continue;
            }
            auto tokens = json::array();
            for (int segment = 0; segment < whisper_full_n_segments(context.get()); ++segment) {
                const int count = whisper_full_n_tokens(context.get(), segment);
                for (int index = 0; index < count; ++index) {
                    auto data = whisper_full_get_token_data(context.get(), segment, index);
                    if (data.id >= whisper_token_eot(context.get())) continue;
                    std::string text = whisper_token_to_str(context.get(), data.id);
                    float probability = data.p;
                    while (index + 1 < count && utf8_trailing_bytes_needed(text) > 0) {
                        auto next = whisper_full_get_token_data(context.get(), segment, ++index);
                        text += whisper_token_to_str(context.get(), next.id);
                        probability = std::min(probability, next.p);
                    }
                    if (data.t_dtw >= 0 && std::isfinite(probability)) {
                        tokens.push_back({{"text", text}, {"start", data.t_dtw / 100.0}, {"probability", probability}});
                    }
                }
            }
            reply({{"state", "ready"}, {"tokens", tokens}});
        } catch (const std::exception &) { reply({{"state", "error"}}); }
    }
    return 0;
}
