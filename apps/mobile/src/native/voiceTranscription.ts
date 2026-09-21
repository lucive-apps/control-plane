import { Platform } from "react-native";

import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  if (Platform.OS === "ios") {
    return require("./voiceTranscription.ios").getLocalVoiceTranscriber();
  }
  return null;
}
