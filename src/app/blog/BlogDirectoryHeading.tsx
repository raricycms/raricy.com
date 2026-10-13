import BlogDirectoryScene from './BlogDirectoryScene';

export default function BlogDirectoryHeading() {
  return (
    <section className="blogs-hero" aria-labelledby="blog-directory-title">
      <div className="container blog-directory-heading">
        <BlogDirectoryScene />
        <div className="blog-directory-heading__text">
          <h1 id="blog-directory-title">博客</h1>
          <p>分享思考与见解</p>
        </div>
      </div>
    </section>
  );
}
