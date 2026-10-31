// The real Marc Innotech monogram, shared with the main page
// (marcinnotech.net): nested MIT mark, extracted byte-identical from the
// teaser source (57,578-byte transparent WebP). It lives in public/ so the
// build copies it to dist/ as-is; wrangler deploys carry binary files fine,
// unlike the text-only GitHub snapshot path.
export default function Mark({ size = 40 }: { size?: number }) {
  return (
    <img
      src="/mit-monogram.webp"
      width={size}
      height={size}
      alt="Marc Innotech monogram"
      style={{ objectFit: "contain", display: "block" }}
    />
  );
}
