const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const content = $("content");
const output = $("output");
const fileMeta = $("file-meta");
const fileInput = $("file-input");
const tocList = $("toc-list");
const toc = $("toc");
const tocToggle = $("toc-toggle");
const tocScrim = $("toc-scrim");
const fileOpen = $("file-open");
const tocMedia = matchMedia("(width <= 900px)");
let tocOpen = root.classList.contains("toc-open");

function setTocOpen(next) {
  tocOpen = next;
  root.classList.toggle("toc-open", tocOpen);
  tocToggle.setAttribute("aria-expanded", String(tocOpen));
  tocToggle.textContent = tocOpen ? "Hide contents" : "Show contents";
  toc.setAttribute("aria-hidden", String(!tocOpen));
}

setTocOpen(tocOpen);

function setEmptyState(isEmpty, message) {
  content.dataset.empty = String(isEmpty);
  if (message !== undefined) fileMeta.textContent = message;
  if (isEmpty) output.innerHTML = "";
}

function slugify(text) {
  const base = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

function renderMath() {
  if (!window.renderMathInElement) return;
  renderMathInElement(output, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
      { left: "\\[", right: "\\]", display: true },
    ],
    throwOnError: false,
  });
}

function renderMarkdown(md, label) {
  if (!window.marked) {
    setEmptyState(true, "Markdown parser failed to load");
    return;
  }
  output.innerHTML = marked.parse(md, {
    gfm: true,
    breaks: false,
    mangle: false,
    headerIds: false,
  });
  setEmptyState(false, label || "Markdown loaded");
  generateTOC();
  renderMath();
}

function generateTOC() {
  const headings = output.querySelectorAll("h1, h2, h3, h4, h5, h6");
  tocList.replaceChildren();

  if (!headings.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No headings found";
    tocList.append(empty);
    return;
  }

  const ul = document.createElement("ul");
  const counts = new Map();

  for (const heading of headings) {
    const level = Number(heading.tagName[1]);
    if (!heading.id) {
      const base = slugify(heading.textContent);
      const count = counts.get(base) || 0;
      heading.id = count ? `${base}-${count + 1}` : base;
      counts.set(base, count + 1);
    }
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${heading.id}`;
    a.textContent = heading.textContent;
    a.style.paddingInlineStart = `${(level - 1) * 0.75}rem`;
    li.append(a);
    ul.append(li);
  }

  tocList.append(ul);
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.(md|markdown)$/i.test(file.name)) {
    setEmptyState(true, "Please drop a .md file");
    return;
  }
  renderMarkdown(await file.text(), `Viewing ${file.name}`);
}

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer?.files?.[0]);
});

fileOpen.addEventListener("click", () => fileInput.click());
tocToggle.addEventListener("click", () => setTocOpen(!tocOpen));
tocScrim.addEventListener("click", () => setTocOpen(false));

tocList.addEventListener("click", (e) => {
  if (e.target.tagName === "A" && tocMedia.matches) setTocOpen(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && tocOpen && tocMedia.matches) setTocOpen(false);
});

fileInput.addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
  fileInput.value = "";
});

fetch(window.MD_INTRO_URL || "./intro.md")
  .then((r) => r.text())
  .then((md) => md && renderMarkdown(md, "intro.md"))
  .catch(() => setEmptyState(true, "No file loaded"));