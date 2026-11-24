(() => {
	const valid = (theme) => theme === "light" || theme === "dark";
	let theme = new URLSearchParams(location.search).get("theme");
	if (!valid(theme)) {
		try {
			theme = localStorage.getItem("ravena-admin-theme");
		} catch {
			theme = null;
		}
	}
	if (valid(theme)) document.documentElement.dataset.theme = theme;
})();
