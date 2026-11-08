(() => {
  const root = document.documentElement;

  // Language: <head> picks the initial value before paint; this wires the toggle.
  const setLang = (lang) => {
    root.dataset.lang = lang;
    root.lang = lang === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem("omp-web-site-lang", lang); } catch { /* private mode */ }
    document.querySelectorAll("[data-set-lang]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.setLang === lang));
    });
    const title = document.querySelector(`meta[name="title-${lang}"]`);
    if (title) document.title = title.content;
  };
  document.querySelectorAll("[data-set-lang]").forEach((button) => {
    button.addEventListener("click", () => setLang(button.dataset.setLang));
  });
  setLang(root.dataset.lang === "zh" ? "zh" : "en");

  // Screenshot tabs.
  const tabs = [...document.querySelectorAll("[role=tab]")];
  const select = (tab) => {
    tabs.forEach((t) => {
      const active = t === tab;
      t.setAttribute("aria-selected", String(active));
      t.tabIndex = active ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls"))?.classList.toggle("active", active);
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      select(next);
      next.focus();
    });
  });

  // Copy buttons copy the text of the <code> beside them.
  document.querySelectorAll(".copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.parentElement.querySelector("code")?.textContent.trim() ?? "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(button.parentElement.querySelector("code"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
      }
      button.classList.add("done");
      const labels = button.querySelectorAll("[lang]");
      const previous = [...labels].map((label) => label.textContent);
      labels.forEach((label) => { label.textContent = label.lang === "zh-CN" ? "已复制" : "Copied"; });
      setTimeout(() => {
        button.classList.remove("done");
        labels.forEach((label, i) => { label.textContent = previous[i]; });
      }, 1600);
    });
  });

  // Nav border once the page scrolls.
  const nav = document.querySelector(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Reveal on scroll.
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
  } else {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
  }

  // GitHub star count (optional; the button works without it).
  fetch("https://api.github.com/repos/leafiy/omp-web")
    .then((response) => (response.ok ? response.json() : null))
    .then((repo) => {
      if (!repo || typeof repo.stargazers_count !== "number" || repo.stargazers_count < 10) return;
      const count = repo.stargazers_count;
      const label = count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(count);
      document.querySelectorAll(".stars").forEach((el) => { el.textContent = `★ ${label}`; });
    })
    .catch(() => {});
})();
