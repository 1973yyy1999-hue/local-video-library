(function (root) {
  function createSearcher(videos, FuseClass) {
    // Build once per searchable-data revision, not once per keystroke.
    let index;
    return query => {
      const tokens = query.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return videos.slice();
      index ||= new FuseClass(videos, { keys: [{ name: 'name', weight: 3 }, { name: 'folder', weight: 1 }, { name: 'tags', weight: 2 }], threshold: 0.35, ignoreLocation: true, includeScore: true, minMatchCharLength: 1 });
      let scores;
      for (const token of tokens) {
        const hits = new Map(index.search(token).map(hit => [hit.item.id, { item: hit.item, score: hit.score || 0 }]));
        if (!scores) scores = hits;
        else for (const [id, hit] of scores) { if (!hits.has(id)) scores.delete(id); else hit.score += hits.get(id).score; }
      }
      return [...scores.values()].sort((a, b) => a.score - b.score).map(hit => hit.item);
    };
  }
  const searchVideos = (videos, query, FuseClass) => createSearcher(videos, FuseClass)(query);
  if (typeof module !== 'undefined') module.exports = { searchVideos, createSearcher };
  else Object.assign(root, { searchVideos, createSearcher });
})(globalThis);
