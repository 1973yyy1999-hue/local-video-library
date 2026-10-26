const paths = {
  minus: ['M5 12h14'], maximize: ['M5 5h14v14H5z'], restore: ['M8 4h12v12M4 8h12v12H4z'],
  check: ['m5 12 4 4L19 6'], tag: ['M3 3h8l10 10-8 8L3 11Z', 'M7 7h.01'], copy: ['M8 8h12v13H8z', 'M4 16H2V2h13v2'],
  play: ['m9 5 11 7-11 7z'], library: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
  heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
  folder: ['M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z'],
  search: ['M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z', 'm16 16 5 5'],
  plus: ['M12 5v14M5 12h14'], close: ['m6 6 12 12M6 18 18 6'], refresh: ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2 5'],
  settings: ['M4 6h16M4 12h16M4 18h16', 'M8 3v6M16 9v6M10 15v6'],
  full: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'], pip: ['M3 4h18v16H3z', 'M12 12h7v6h-7z'],
  external: ['M14 3h7v7M21 3 11 13', 'M10 4H4v16h16v-6'], more: ['M5 12h1M11 12h1M17 12h1'], disk: ['M5 4h14l3 13H2Z', 'M2 17v3h20v-3M6 17h1'], arrow: ['m9 5 7 7-7 7']
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value);
  for (const d of paths[name] || paths.play) { const item = document.createElementNS(svg.namespaceURI, 'path'); item.setAttribute('d', d); svg.append(item); }
  return svg;
}
export function decorate() { document.querySelectorAll('[data-icon]').forEach(node => node.prepend(icon(node.dataset.icon))); }
