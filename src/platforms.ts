/**
 * Platform descriptors ported verbatim from Qexo
 * (hexoweb/libs/platforms/configs/*.py).
 */

export interface Section {
  path: string[];
  depth: number[];
  type: string[];
  save_path?: string | null;
  scaffold?: string;
  excludes?: string[];
}

export interface PlatformConfig {
  name: string;
  posts: Section;
  drafts: Section;
  pages: Section;
  configs: Section;
}

const hexo: PlatformConfig = {
  name: "Hexo",
  posts: {
    path: ["source/_posts"],
    depth: [-1],
    type: [".md"],
    save_path: "source/_posts/${filename}.md",
    scaffold: "scaffolds/post.md",
  },
  drafts: {
    path: ["source/_drafts"],
    depth: [-1],
    type: [".md"],
    save_path: "source/_drafts/${filename}.md",
    scaffold: "scaffolds/draft.md",
  },
  pages: {
    path: ["source"],
    depth: [2],
    type: [".md", ".html"],
    save_path: "source/${filename}.md",
    scaffold: "scaffolds/page.md",
    excludes: ["_posts", "_drafts"],
  },
  configs: {
    path: [".github", "", "themes", "source", "source/_data"],
    depth: [3, 1, 2, 1, 1],
    type: [".yml", ".yaml", ".toml", ".json"],
    save_path: "",
  },
};

const hugo: PlatformConfig = {
  name: "Hugo",
  posts: {
    path: ["content/posts"],
    depth: [-1],
    type: [".md"],
    save_path: "content/posts/${filename}.md",
    scaffold: "archetypes/post.md",
  },
  drafts: {
    path: ["content/_drafts"],
    depth: [-1],
    type: [".md"],
    save_path: "content/_drafts/${filename}.md",
    scaffold: "archetypes/draft.md",
  },
  pages: {
    path: ["content"],
    depth: [3],
    type: [".md", ".html"],
    save_path: "content/${filename}/index.md",
    scaffold: "archetypes/page.md",
    excludes: ["post", "_drafts"],
  },
  configs: {
    path: [".github", "", "themes", "config"],
    depth: [3, 1, 2, 2],
    type: [".yml", ".yaml", ".toml", ".json"],
    save_path: "",
  },
};

const valaxy: PlatformConfig = {
  name: "Valaxy",
  posts: {
    path: ["pages/posts"],
    depth: [-1],
    type: [".md"],
    save_path: "pages/posts/${filename}.md",
    scaffold: "scaffolds/post.md",
  },
  drafts: {
    path: ["pages/_drafts"],
    depth: [-1],
    type: [".md"],
    save_path: "pages/_drafts/${filename}.md",
    scaffold: "scaffolds/draft.md",
  },
  pages: {
    path: ["pages"],
    depth: [2],
    type: [".md", ".html"],
    save_path: "pages/${filename}",
    scaffold: "scaffolds/page.md",
    excludes: ["posts", "_drafts"],
  },
  configs: {
    path: [".github", ""],
    depth: [3, 1],
    type: [".yml", ".yaml", ".config.ts", ".toml", ".json"],
    save_path: "",
  },
};

const vuepress: PlatformConfig = {
  name: "Vuepress",
  posts: {
    path: ["blogs", "posts", "articles", "archives"],
    depth: [-1, -1, -1, -1],
    type: [".md"],
    save_path: "${filename}.md",
    scaffold: "",
    excludes: [".vuepress"],
  },
  drafts: { path: [], depth: [], type: [], save_path: null, scaffold: "" },
  pages: {
    path: [""],
    depth: [-1],
    type: [".md"],
    save_path: "${filename}.md",
    scaffold: "",
    excludes: [".vuepress", "blogs", "posts", "articles", "archives"],
  },
  configs: {
    path: [".github", ".vuepress", ""],
    depth: [3, 2, 1],
    type: [".yml", ".yaml", ".toml", ".js", ".ts", ".json", ".styl", ".html", ".vue"],
    save_path: "",
  },
};

const vitepress: PlatformConfig = {
  name: "Vitepress",
  posts: {
    path: ["blogs", "posts", "articles", "archives"],
    depth: [-1, -1, -1, -1],
    type: [".md"],
    save_path: "${filename}.md",
    scaffold: "",
    excludes: [".vitepress"],
  },
  drafts: { path: [], depth: [], type: [], save_path: null, scaffold: "" },
  pages: {
    path: [""],
    depth: [-1],
    type: [".md"],
    save_path: "${filename}.md",
    scaffold: "",
    excludes: [".vitepress", "blogs", "posts", "articles", "archives"],
  },
  configs: {
    path: [".github", ".vitepress", ""],
    depth: [3, 2, 1],
    type: [".yml", ".yaml", ".toml", ".js", ".ts", ".json", ".styl", ".html", ".vue"],
    save_path: "",
  },
};

const nuxt: PlatformConfig = {
  name: "Nuxt",
  posts: {
    path: ["content/posts"],
    depth: [-1],
    type: [".md"],
    save_path: "content/posts/${filename}.md",
    scaffold: "scaffolds/post.md",
  },
  drafts: {
    path: ["content/drafts"],
    depth: [-1],
    type: [".md"],
    save_path: "content/drafts/${filename}.md",
    scaffold: "scaffolds/draft.md",
  },
  pages: {
    path: ["content"],
    depth: [1],
    type: [".md", ".html"],
    save_path: "content/${filename}.md",
    scaffold: "scaffolds/page.md",
    excludes: ["content/posts"],
  },
  configs: {
    path: [".github", "", "app"],
    depth: [3, 1, 2],
    type: [".ts", ".json", ".yml"],
    save_path: "",
  },
};

const astro: PlatformConfig = {
  name: "Astro",
  posts: {
    path: ["src/content", "content", "src/pages", "src/pages/blog"],
    depth: [-1, -1, -1, -1],
    type: [".md", ".html"],
    save_path: "src/content/${filename}.md",
    scaffold: "scaffolds/post.md",
  },
  drafts: {
    path: ["src/drafts", "drafts"],
    depth: [-1, -1],
    type: [".md", ".html"],
    save_path: "src/drafts/${filename}.md",
    scaffold: "scaffolds/draft.md",
  },
  pages: {
    path: ["src/pages"],
    depth: [-1],
    type: [".md", ".html"],
    save_path: "src/pages/${filename}.md",
    scaffold: "scaffolds/page.md",
    excludes: ["public", "components"],
  },
  configs: {
    path: ["", ".github", "src", "public"],
    depth: [1, 3, 2, 1],
    type: [".mjs", ".js", ".ts", ".json", ".toml", ".yaml", ".yml"],
    save_path: "",
  },
};

export const PLATFORMS: Record<string, PlatformConfig> = {
  Hexo: hexo,
  Hugo: hugo,
  Valaxy: valaxy,
  Vuepress: vuepress,
  Vitepress: vitepress,
  Nuxt: nuxt,
  Astro: astro,
};

export function platformNames(): string[] {
  return Object.keys(PLATFORMS);
}

export function getPlatform(name: string | undefined): PlatformConfig {
  return PLATFORMS[name || "Hexo"] ?? hexo;
}

/** Replaces ${filename} in a save_path template. */
export function resolveSavePath(template: string, filename: string): string {
  return template.replace(/\$\{filename\}/g, filename);
}
