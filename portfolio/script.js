(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const revealEls = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) {
    revealEls.forEach((el) => el.classList.add("in"));
  } else {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach((el) => revealObserver.observe(el));
  }

  const nav = document.querySelector(".nav");
  const links = [...document.querySelectorAll('.nav a[href^="#"]')];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if ("IntersectionObserver" in window) {
    const navObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = `#${entry.target.id}`;
        links.forEach((link) => link.classList.toggle("is-active", link.getAttribute("href") === id));
      });
    }, { rootMargin: "-42% 0px -48% 0px", threshold: 0 });
    sections.forEach((section) => navObserver.observe(section));
  }

  const topButton = document.querySelector(".to-top");
  const road = document.querySelector(".road");
  const onScroll = () => {
    nav.classList.toggle("is-stuck", window.scrollY > 8);
    topButton.classList.toggle("is-on", window.scrollY > 640);
    if (!road) return;
    const rect = road.getBoundingClientRect();
    const total = Math.max(road.offsetHeight - window.innerHeight * 0.35, 1);
    const seen = Math.min(Math.max(-rect.top + window.innerHeight * 0.3, 0), total);
    road.style.setProperty("--road", String(seen / total));
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  topButton.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });

  const cycle = document.querySelector("[data-cycle]");
  if (cycle) {
    const steps = [...cycle.querySelectorAll("[data-step]")];
    const copies = [...cycle.querySelectorAll("[data-cycle-text]")];
    let index = 0;
    let timer = 0;
    const show = (next) => {
      index = next;
      steps.forEach((step, stepIndex) => {
        const on = stepIndex === next;
        step.classList.toggle("is-on", on);
        step.setAttribute("aria-selected", on ? "true" : "false");
      });
      copies.forEach((copy, copyIndex) => {
        copy.hidden = copyIndex !== next;
      });
    };
    const stop = () => window.clearInterval(timer);
    const start = () => {
      if (reduce) return;
      stop();
      timer = window.setInterval(() => show((index + 1) % steps.length), 2600);
    };
    steps.forEach((step, stepIndex) => {
      step.addEventListener("click", () => {
        show(stepIndex);
        stop();
      });
    });
    show(0);
    start();
  }

  document.querySelectorAll("[data-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.layer;
      document.querySelectorAll("[data-layer]").forEach((item) => {
        const on = item === button;
        item.classList.toggle("is-on", on);
        item.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-layer-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.layerPanel !== id;
      });
    });
  });

  const picks = document.querySelectorAll("[data-pick]");
  const showPick = (id) => {
    picks.forEach((button) => button.classList.toggle("is-on", button.dataset.pick === id));
    document.querySelectorAll("[data-pick-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.pickPanel !== id;
    });
  };
  picks.forEach((button) => {
    button.addEventListener("mouseenter", () => showPick(button.dataset.pick));
    button.addEventListener("focus", () => showPick(button.dataset.pick));
    button.addEventListener("click", () => showPick(button.dataset.pick));
  });

  document.querySelectorAll("[data-tabs]").forEach((root) => {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const panels = [...root.querySelectorAll('[role="tabpanel"]')];
    const select = (id) => {
      tabs.forEach((tab) => {
        const on = tab.getAttribute("aria-controls") === id;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
      });
      panels.forEach((panel) => {
        panel.hidden = panel.id !== id;
      });
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(tab.getAttribute("aria-controls")));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(index + direction + tabs.length) % tabs.length];
        next.focus();
        select(next.getAttribute("aria-controls"));
      });
    });
  });

  document.querySelectorAll("[data-journey]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.journey;
      document.querySelectorAll("[data-journey]").forEach((item) => {
        item.setAttribute("aria-pressed", item === button ? "true" : "false");
      });
      document.querySelectorAll("[data-journey-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.journeyPanel !== key;
      });
    });
  });

  document.querySelectorAll("[data-jstep]").forEach((step) => {
    step.addEventListener("click", () => {
      const panel = step.closest("[data-journey-panel]");
      panel.querySelectorAll("[data-jstep]").forEach((item) => item.classList.toggle("is-on", item === step));
      panel.querySelectorAll("[data-jscreen]").forEach((screen) => {
        screen.hidden = screen.dataset.jscreen !== step.dataset.jstep;
      });
    });
  });

  document.querySelectorAll("[data-ia]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-ia]").forEach((item) => item.classList.toggle("is-on", item === button));
      document.querySelectorAll("[data-ia-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.iaPanel !== button.dataset.ia;
      });
    });
  });

  const caps = [...document.querySelectorAll("[data-cap]")];
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) => {
        const on = item === button;
        item.classList.toggle("is-on", on);
        item.setAttribute("aria-pressed", on ? "true" : "false");
      });
      caps.forEach((card) => {
        card.hidden = filter !== "all" && card.dataset.cap !== filter;
      });
    });
  });

  const net = document.querySelector(".net");
  const activateRel = (id) => {
    document.querySelectorAll("[data-rel]").forEach((node) => node.classList.toggle("is-on", node.dataset.rel === id));
    document.querySelectorAll("[data-edge]").forEach((edge) => edge.classList.toggle("is-hot", edge.dataset.edge === id || id === "a"));
    document.querySelectorAll("[data-rel-copy]").forEach((copy) => {
      copy.hidden = copy.dataset.relCopy !== id;
    });
  };
  document.querySelectorAll("[data-rel]").forEach((node) => {
    node.addEventListener("mouseenter", () => activateRel(node.dataset.rel));
    node.addEventListener("focus", () => activateRel(node.dataset.rel));
    node.addEventListener("click", () => activateRel(node.dataset.rel));
  });
  if (net && !reduce && "IntersectionObserver" in window) {
    const netObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      net.classList.add("is-drawn");
      netObserver.disconnect();
    }, { threshold: 0.35 });
    netObserver.observe(net);
  } else if (net) {
    net.classList.add("is-drawn");
  }
})();
