// Native inference is cached and never blocks player heartbeats or capture.
// Chrome owns the model; no text is sent to an external service.
export function createTextDetector(api = globalThis.LanguageDetector) {
  let detector = null, creating = null, status = api ? 'loading' : 'unsupported';
  const cache = new Map();
  function create() {
    if (!api || detector || creating) return;
    status = 'loading';
    try {
      creating = Promise.resolve(api.create()).then(value => { detector = value; status = 'available'; cache.clear(); }, () => { status = 'error'; })
        .finally(() => { creating = null; });
    } catch { status = 'error'; }
  }
  if (api) Promise.resolve().then(() => api.availability()).then(value => {
    status = ['available','downloadable','downloading','unavailable'].includes(value) ? value : 'unavailable';
    if (value === 'available') create();
  }, () => { status = 'error'; });
  return {
    // Called synchronously from a trusted user gesture when a model is needed.
    enable() { if (['downloadable','downloading','error'].includes(status)) create(); },
    lookup(text) {
      const input = text.slice(0, 10000);
      if ((input.match(/\p{L}/gu)?.length ?? 0) < 30) return { status: 'too-short', candidates: [] };
      if (!detector) return { status, candidates: [] };
      if (cache.has(input)) return cache.get(input);
      const result = { status: 'loading', candidates: [] };
      cache.set(input,result);
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      Promise.resolve().then(() => detector.detect(input)).then(rows => {
        result.candidates = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.detectedLanguage === 'string' && row.detectedLanguage.length <= 64 && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1)
          .sort((a,b) => b.confidence-a.confidence).slice(0,5).map(row => ({ language: row.detectedLanguage, confidence: row.confidence }));
        result.status = 'available';
      }, () => { result.status = 'error'; });
      return result;
    },
  };
}
