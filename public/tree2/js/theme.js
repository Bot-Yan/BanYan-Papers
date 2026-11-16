(() => {
  const root = document.documentElement;
  if (window.tree2Theme) return;

  const key = 'tree2.pref';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let localChoice;
  let animation;

  function preferences() {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function label(button) {
    const action = root.dataset.theme === 'dark' ? '切换至亮色' : '切换至暗色';
    button.setAttribute('aria-label', action);
    button.title = action;
  }

  function refresh() {
    const theme = localChoice ?? preferences().theme;
    root.dataset.theme = theme === 'light' || theme === 'dark' ? theme : system.matches ? 'dark' : 'light';
    const chrome = document.querySelector('meta[name="theme-color"]');
    if (chrome) chrome.content = root.dataset.theme === 'dark' ? '#17191d' : '#fffaf0';
    document.querySelectorAll('[data-theme-toggle]').forEach(label);
  }

  window.tree2Theme = { refresh };
  refresh();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh, { once: true });
  if (system.addEventListener) system.addEventListener('change', refresh);
  else system.addListener(refresh);
  window.addEventListener('pageshow', refresh);
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== key) return;
    localChoice = undefined;
    refresh();
  });

  document.addEventListener('click', event => {
    if (!event.target.closest?.('[data-theme-toggle]')) return;
    const choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
    const apply = () => {
      try {
        localStorage.setItem(key, JSON.stringify({ ...preferences(), theme: choice }));
        localChoice = undefined;
      } catch {
        localChoice = choice;
      }
      refresh();
    };

    if (reducedMotion.matches) return apply();
    if (root.hasAttribute('data-theme-animate') && matchMedia('(pointer: coarse)').matches && document.startViewTransition) {
      document.startViewTransition(apply);
      return;
    }
    root.classList.add('theme-anim');
    apply();
    clearTimeout(animation);
    animation = setTimeout(() => root.classList.remove('theme-anim'), 450);
  });
})();
