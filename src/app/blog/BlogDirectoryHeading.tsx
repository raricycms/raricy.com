/** 原创书页插画：沿用首页的分面配色，构图改为书本与叶枝，避免重复首页山景。 */
export default function BlogDirectoryHeading() {
  return (
    <section className="blogs-hero">
      <div className="container blog-directory-heading">
        <h1>博客</h1>
        <svg className="blog-directory-art" viewBox="0 0 300 170" aria-hidden="true" focusable="false">
          <circle cx="235" cy="53" r="31" fill="var(--directory-art-warm)" />
          <path d="M26 126 143 156 278 122 161 92Z" fill="var(--directory-art-ground)" />
          <path d="m42 98 99 23 116-31 7 35-119 32-107-29Z" fill="var(--directory-art-cover)" />
          <path d="m141 121 4 36 119-32-7-35Z" fill="var(--directory-art-cover-shade)" />
          <path d="M49 84c35-6 62 1 91 23 29-30 66-42 108-40l7 47c-42-1-81 11-112 31-29-18-60-29-99-27Z" fill="var(--directory-art-paper-shade)" />
          <path d="M48 73c36-5 67 5 91 27 29-31 63-47 105-47l5 46c-42 1-79 13-108 35-28-19-60-29-98-28Z" fill="var(--directory-art-paper)" />
          <path d="M139 100c29-31 63-47 105-47l5 46c-42 1-79 13-108 35Z" fill="var(--directory-art-paper-light)" />
          <path d="m141 134-2-34m7 43-1 9M53 116c29 2 54 9 78 24m24-4c25-14 52-22 80-26" fill="none" stroke="var(--directory-art-line)" strokeWidth="1.5" />
          <path d="M62 86c24 0 43 6 62 19M60 94c24 1 44 7 62 19m39-17c18-13 38-21 60-24m-58 33c19-12 39-19 60-22m-58 31c19-11 39-17 60-20" fill="none" stroke="var(--directory-art-line)" strokeWidth="2" strokeLinecap="round" />
          <path d="m161 111 10 24 10-3-11-25Z" fill="var(--directory-art-ribbon)" />
          <path d="M91 74C85 54 74 36 58 24" fill="none" stroke="var(--directory-art-stem)" strokeWidth="2" strokeLinecap="round" />
          <path d="M70 38c-18 3-28-3-31-17 17-2 27 4 31 17Zm7 13c2-19 11-28 26-28-2 18-11 27-26 28ZM86 64c-17 3-28-1-34-14 17-4 28 1 34 14Z" fill="var(--directory-art-leaf)" />
          <path d="m271 81 13-26 5 2-13 26-6 6Z" fill="var(--directory-art-cover)" />
          <path d="m270 89 1-8 5 2Z" fill="var(--directory-art-stem)" />
        </svg>
      </div>
    </section>
  );
}
