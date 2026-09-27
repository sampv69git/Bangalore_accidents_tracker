/**
 * Scene photo handling: privacy-preserving re-encode + optional severity
 * estimate from a free vision model (same budget/model list as the AI features).
 */
import { chatJSON, visionModels, llmAvailable } from '../ai/llm.mjs';

let sharpMod = null;
async function sharp() {
  if (!sharpMod) sharpMod = (await import('sharp')).default;
  return sharpMod;
}

/** Normalise orientation, cap at 1600 px and re-encode as JPEG (drops EXIF/device metadata). */
export async function processScenePhoto(buffer) {
  const S = await sharp();
  return S(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

/**
 * Estimated severity of a crash photo. Returns null when no model is
 * available or the reply is unusable — never guesses a default.
 * @param {Buffer|string} image JPEG buffer or an http(s) URL
 */
export async function assessScenePhoto(image) {
  if (!llmAvailable()) return null;
  let url = image;
  if (Buffer.isBuffer(image)) {
    const S = await sharp();
    const small = await S(image).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    url = `data:image/jpeg;base64,${small.toString('base64')}`;
  }
  if (typeof url !== 'string' || !/^(https?:|data:image\/)/i.test(url)) return null;
  try {
    const { json, model } = await chatJSON({
      models: visionModels(),
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 45000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'A bystander sent this photo of a road accident in Bengaluru to request an ambulance. Estimate how serious it looks. Answer with JSON only: {"severity": "fatal" | "serious" | "minor", "description": "one short factual sentence about visible vehicles, damage and people"}. Do not speculate beyond what is visible.' },
          { type: 'image_url', image_url: { url } },
        ],
      }],
      validate: (j) => { if (!['fatal', 'serious', 'minor'].includes(j?.severity)) throw new Error('Reply missing severity'); },
    });
    return { severity: json.severity, description: String(json.description || '').slice(0, 300), model };
  } catch {
    return null;
  }
}
