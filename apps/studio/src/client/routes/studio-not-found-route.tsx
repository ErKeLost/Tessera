import { Link } from "react-router";

export function StudioNotFoundRoute() {
  return (
    <section className="studio-not-found">
      <span className="studio-page-kicker">404 / workspace route</span>
      <h1>This surface does not exist.</h1>
      <Link to="/">Return to Tessera home</Link>
    </section>
  );
}
