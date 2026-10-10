// Variant handling shared by every page. ?variant=b (remembered in sessionStorage) switches to the
// changed UI that healing tests run against:
//   - renamed test ids (fingerprint heals),
//   - reworded buttons and a moved menu (AI heals).
(() => {
  const fromUrl = new URLSearchParams(location.search).get('variant');
  if (fromUrl) sessionStorage.setItem('variant', fromUrl);
  const variant = sessionStorage.getItem('variant') || 'a';
  window.DEMO = {
    variant,
    /** Picks the variant A or variant B value. */
    v: (a, b) => (variant === 'b' ? b : a),
  };
})();
