import { File } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';

import { engine } from '../modules/puffer-native/src';

export const MODEL_BYTES = 387_710_976;

export type ModelState =
  | { phase: 'checking' }
  | { phase: 'absent' }
  | { phase: 'downloading'; written: number; total: number }
  | { phase: 'loading' }
  | { phase: 'ready'; loadMs: number; backend: string }
  | { phase: 'error'; message: string };

// The native engine owns where the model lives; the download writes exactly there.
const modelFile = () => new File(engine.modelPath());
const modelUrl = () =>
  `https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm/resolve/main/${modelFile().name}`;

export function isModelDownloaded() {
  const file = modelFile();
  return file.exists && file.size === MODEL_BYTES;
}

export async function downloadModel(onProgress: (written: number, total: number) => void) {
  if (isModelDownloaded()) return;
  const part = new File(`${engine.modelPath()}.part`);
  if (part.exists) part.delete();
  const task = createDownloadResumable(modelUrl(), part.uri, {}, ({ totalBytesWritten, totalBytesExpectedToWrite }) =>
    onProgress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : MODEL_BYTES),
  );
  const done = await task.downloadAsync();
  if (!done || done.status !== 200) throw new Error(`Model download failed (HTTP ${done?.status ?? 'none'})`);
  const target = modelFile();
  if (target.exists) target.delete();
  part.move(target);
}
