import React from "react";
import { Link } from "react-router-dom";

export default function SiteHeader() {
  return (
    <div className="site-header">
      <div className="site-header-inner">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Reel Cut
        </Link>
        <div className="live-indicator">
          <span className="live-dot" aria-hidden="true" />
          Engine online
        </div>
      </div>
    </div>
  );
}
