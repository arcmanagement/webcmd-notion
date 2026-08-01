function normalized(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildButtonProbeScript(label, { mark = false } = {}) {
  const requested = normalized(label);
  return `(() => {
    const requested = ${JSON.stringify(requested)};
    const normalized = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    document.querySelectorAll('[data-webcmd-notion-button-target]').forEach((node) => {
      node.removeAttribute('data-webcmd-notion-button-target');
    });
    const matches = Array.from(document.querySelectorAll('button, [role="button"]')).filter((node) => {
      if (!visible(node)) return false;
      const values = [node.textContent, node.getAttribute('aria-label')].map(normalized).filter(Boolean);
      return values.includes(requested);
    });
    if (matches.length !== 1) {
      return { label: requested, exactMatches: matches.length, enabled: false, marked: false };
    }
    const target = matches[0];
    const disabled = target.disabled === true
      || target.getAttribute('aria-disabled') === 'true'
      || target.hasAttribute('disabled');
    if (${mark === true ? 'true' : 'false'} && !disabled) {
      target.setAttribute('data-webcmd-notion-button-target', 'true');
    }
    return {
      label: requested,
      exactMatches: 1,
      enabled: !disabled,
      marked: ${mark === true ? 'true' : 'false'} && !disabled,
    };
  })()`;
}

export function buttonProbeError(result) {
  if (!result || typeof result !== 'object') return 'Notion button inspection returned an invalid result';
  if (result.exactMatches === 0) return `Notion button was not found: ${result.label}`;
  if (result.exactMatches !== 1)
    return `Notion button label is ambiguous: ${result.label} matched ${result.exactMatches} buttons`;
  if (result.enabled !== true) return `Notion button is disabled: ${result.label}`;
  return '';
}
