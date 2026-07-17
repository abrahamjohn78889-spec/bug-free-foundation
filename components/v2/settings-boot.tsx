"use client"

/**
 * SettingsBoot — applies user-preference body classes (density, ambient,
 * wallpaper, motion) before first paint to avoid a visible flash.
 * The tiny inline script reads localStorage and toggles body classes.
 * Zero runtime footprint after initial render.
 */
export function SettingsBoot() {
  const boot = `
(function(){try{
  var s = JSON.parse(localStorage.getItem('btc5m.ui') || '{}');
  var b = document.body;
  if (s.density === 'compact') b.classList.add('density-compact');
  if (s.ambient === false) b.classList.add('ambient-off');
  if (s.wallpaper === 'cyber') b.classList.add('wallpaper-cyber');
  if (s.motion === false) b.classList.add('motion-off');
}catch(e){}})();
  `.trim()
  return <script dangerouslySetInnerHTML={{ __html: boot }} />
}
