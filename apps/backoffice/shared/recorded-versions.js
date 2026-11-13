// Shared recording identities, version controls and exact-evidence verification.
// History and Languages group by video. Neither owns these details.
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const versionKey = (version) => `${version.deviceId}:${version.metadataId}`;
export const recordedVersions = (record) => Array.isArray(record.versions) && record.versions.length ? record.versions : [record];
export const findVersion = (record, key) => recordedVersions(record).find((v) => versionKey(v) === key) || recordedVersions(record)[0];

export function versionPickerHTML(record, selected, label, { id = 'f-version', action = 'version', key = 'ins:version' } = {}) {
  const versions = recordedVersions(record);
  if (versions.length < 2) return '';
  return `<label class="vh" for="${escape(id)}">Recorded version</label>
    <select class="select" id="${escape(id)}" data-action="${escape(action)}" data-key="${escape(key)}">${versions.map((v, i) =>
      `<option value="${escape(versionKey(v))}" ${versionKey(v) === selected ? 'selected' : ''}>${escape(label(v, i))}</option>`).join('')}</select>`;
}

export function savedEvidence(data) {
  return {
    evidence: data?.evidence && typeof data.evidence === 'object' && !Array.isArray(data.evidence) ? data.evidence : null,
    text: typeof data?.evidenceText === 'string' ? data.evidenceText : null,
  };
}

export class EvidenceDigests {
  results = new Map();
  pending = new Map();
  key(id, text) { return `${id}\n${text}`; }
  get(id, text) { return this.results.get(this.key(id, text)); }
  check(id, text) {
    const key = this.key(id, text);
    if (this.results.has(key)) return Promise.resolve(this.results.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    const result = (async () => {
      let status = 'unavailable';
      if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
        try {
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
          const hex = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
          status = hex === String(id).toLowerCase() ? 'match' : 'mismatch';
        } catch { /* Exact text remains accessible even without digest support. */ }
      }
      this.results.set(key, status);
      return status;
    })();
    this.pending.set(key, result);
    result.then(() => this.pending.delete(key));
    return result;
  }
}
