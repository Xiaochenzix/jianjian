(() => {
  try {
    const saved = localStorage.getItem('jianjian-theme');
    const theme = saved === 'dark' || saved === 'light' ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  } catch { /* The page still works if storage is blocked. */ }
})();
