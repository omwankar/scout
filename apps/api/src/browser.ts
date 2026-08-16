import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

export type SnapshotElement = {
  id: number;
  role: string;
  name: string;
  value?: string;
};

export type PageSnapshot = {
  url: string;
  title: string;
  elements: SnapshotElement[];
  textPreview: string;
};

type DomElementInfo = {
  id: number;
  role: string;
  name: string;
  value?: string;
};

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private browserbaseSessionId: string | null = null;
  provider: "browserbase" | "local" = "local";

  async launch(): Promise<void> {
    if (config.useBrowserbase) {
      await this.launchBrowserbase();
      return;
    }
    await this.launchLocal();
  }

  private async launchLocal(): Promise<void> {
    this.provider = "local";
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      // bypassCSP lets string-based page.evaluate work on CSP-strict sites.
      bypassCSP: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 ScoutResearchBot/1.0",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);
  }

  private async launchBrowserbase(): Promise<void> {
    this.provider = "browserbase";
    const res = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-API-Key": config.browserbaseApiKey,
      },
      body: JSON.stringify({
        projectId: config.browserbaseProjectId,
        browserSettings: {
          viewport: { width: 1280, height: 800 },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Browserbase session failed (${res.status}): ${text.slice(0, 240)}`);
    }

    const session = (await res.json()) as { id: string; connectUrl?: string };
    this.browserbaseSessionId = session.id;
    const connectUrl =
      session.connectUrl ||
      `wss://connect.browserbase.com?apiKey=${encodeURIComponent(config.browserbaseApiKey)}&sessionId=${encodeURIComponent(session.id)}`;

    this.browser = await chromium.connectOverCDP(connectUrl);
    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? (await this.browser.newContext());
    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(25000);
  }

  getPage(): Page {
    if (!this.page) throw new Error("Browser not launched");
    return this.page;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
    }
    if (this.browserbaseSessionId && config.browserbaseApiKey) {
      await fetch(`https://api.browserbase.com/v1/sessions/${this.browserbaseSessionId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BB-API-Key": config.browserbaseApiKey,
        },
        body: JSON.stringify({ status: "REQUEST_RELEASE" }),
      }).catch(() => undefined);
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.browserbaseSessionId = null;
  }

  async navigate(url: string): Promise<string> {
    const page = this.getPage();
    assertPublicHttpUrl(url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    // Short settle window — waiting for full networkidle wastes seconds on
    // analytics-heavy marketing sites without improving extract quality.
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    await dismissCommonOverlays(page);
    return page.url();
  }

  async click(elementId: number): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-scout-id="${elementId}"]`).first();
    const count = await locator.count();
    if (!count) throw new Error(`Unknown element id ${elementId}`);
    const label = (await locator.getAttribute("data-scout-label")) || String(elementId);
    await locator.click({ timeout: 8000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    return `Clicked "${label}" → ${page.url()}`;
  }

  async type(elementId: number, text: string, submit = false): Promise<string> {
    const page = this.getPage();
    const locator = page.locator(`[data-scout-id="${elementId}"]`).first();
    const count = await locator.count();
    if (!count) throw new Error(`Unknown element id ${elementId}`);
    const label = (await locator.getAttribute("data-scout-label")) || String(elementId);
    await locator.fill(text, { timeout: 8000 });
    if (submit) {
      await locator.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(450);
    }
    return `Typed into "${label}"${submit ? " and submitted" : ""}`;
  }

  async scroll(direction: "up" | "down", amount = 900): Promise<string> {
    const page = this.getPage();
    const delta = direction === "down" ? amount : -amount;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(250);
    return `Scrolled ${direction} by ${amount}px`;
  }

  async extract(): Promise<string> {
    const page = this.getPage();
    await dismissCommonOverlays(page);
    // String evaluate — avoids tsx injecting __name into the browser context.
    const text = (await page.evaluate(`(() => {
      const junk =
        "script,style,noscript,svg,iframe,nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],[aria-hidden='true']";
      const candidates = [
        document.querySelector("main"),
        document.querySelector("article"),
        document.querySelector("[role='main']"),
        document.querySelector("#content"),
        document.querySelector(".content"),
        document.body,
      ].filter(Boolean);
      const root = candidates[0] || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll(junk).forEach((n) => n.remove());
      const kill = [/skip to/i, /cookie/i, /accept all/i, /sign in/i, /log in/i];
      const raw = (clone.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
      const lines = raw
        .split("\\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .filter((l) => !kill.some((re) => re.test(l) && l.length < 80));
      return lines.join("\\n").trim();
    })()`)) as string;

    if (!text || text.length < 80) {
      const fallback = (await page.evaluate(`(() => {
        const clone = document.body.cloneNode(true);
        for (const sel of ["script", "style", "noscript", "svg", "iframe"]) {
          clone.querySelectorAll(sel).forEach((n) => n.remove());
        }
        return (clone.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
      })()`)) as string;
      return fallback.slice(0, 8000);
    }
    return text.slice(0, 8000);
  }

  async screenshot(): Promise<{ base64: string; mimeType: "image/jpeg" }> {
    const page = this.getPage();
    const buf = await page.screenshot({
      type: "jpeg",
      quality: 55,
      fullPage: false,
      timeout: 8000, // never let a slow render stall the agent loop
    });
    return { base64: buf.toString("base64"), mimeType: "image/jpeg" };
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = this.getPage();
    const url = page.url();
    const title = await page.title().catch(() => "");

    const elements = (await page.evaluate(`(() => {
      document.querySelectorAll("[data-scout-id]").forEach((n) => {
        n.removeAttribute("data-scout-id");
        n.removeAttribute("data-scout-label");
      });

      const selectors = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='link']",
        "[role='textbox']",
        "[role='searchbox']",
        "[role='combobox']",
        "[role='menuitem']",
        "[role='tab']",
      ].join(",");

      const nodes = Array.from(document.querySelectorAll(selectors));
      const out = [];
      let id = 1;

      for (const el of nodes) {
        if (id > 40) break;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;

        const tag = el.tagName.toLowerCase();
        const roleAttr = el.getAttribute("role");
        let role = roleAttr || tag;
        if (tag === "a") role = "link";
        if (tag === "button") role = "button";
        if (tag === "textarea") role = "textbox";
        if (tag === "select") role = "combobox";
        if (tag === "input") {
          const type = el.type || "text";
          role =
            type === "submit" || type === "button"
              ? "button"
              : type === "search"
                ? "searchbox"
                : type === "checkbox"
                  ? "checkbox"
                  : type === "radio"
                    ? "radio"
                    : "textbox";
        }

        const name = (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          el.getAttribute("title") ||
          el.value ||
          el.textContent ||
          ""
        )
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 120);

        if (!name) continue;

        el.setAttribute("data-scout-id", String(id));
        el.setAttribute("data-scout-label", name);

        const value =
          tag === "input" || tag === "textarea"
            ? String(el.value || "").slice(0, 80)
            : undefined;

        out.push({ id: id, role: role, name: name, value: value || undefined });
        id += 1;
      }
      return out;
    })()`)) as DomElementInfo[];

    const textPreview = await page
      .evaluate(`(() => {
        const root =
          document.querySelector("main") ||
          document.querySelector("article") ||
          document.querySelector("[role='main']") ||
          document.body;
        const clone = root.cloneNode(true);
        clone
          .querySelectorAll(
            "script,style,noscript,nav,header,footer,aside,[role='navigation']"
          )
          .forEach((n) => n.remove());
        return (clone.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 1400);
      })()`)
      .catch(() => "");

    return {
      url,
      title,
      elements,
      textPreview: typeof textPreview === "string" ? textPreview : "",
    };
  }
}

/** Best-effort dismiss cookie/consent overlays. Single combined query keeps this <0.5s. */
async function dismissCommonOverlays(page: Page): Promise<void> {
  try {
    const btn = page
      .getByRole("button", {
        name: /accept all|accept cookies|i agree|got it|allow all|^ok$/i,
      })
      .first();
    if (await btn.isVisible({ timeout: 350 }).catch(() => false)) {
      await btn.click({ timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(150);
    }
  } catch {
    // never block on overlay handling
  }
}

export function assertPublicHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Local/private network URLs are blocked");
  }
}
