const paths = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
  compose: '<path d="M12 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7M16 3l5 5-10 10-6 1 1-6Z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  accounts: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M19 8v6M16 11h6"/>',
  star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  send: '<path d="m3 3 19 9-19 9 4-9Zm4 9h15"/>',
  attach: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2M5 16l9-9"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
} as const
export type IconName = keyof typeof paths
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = paths[name]
  return svg
}
