(function (root) {
  const duration = value => {
    if (!Number.isFinite(value)) return '—:—';
    const seconds = Math.max(0, Math.floor(value)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const size = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB`;
  if (typeof module !== 'undefined') module.exports = { duration, size }; else root.mediaFormat = { duration, size };
})(globalThis);
