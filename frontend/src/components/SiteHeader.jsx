import React from "react";
import { Link } from "react-router-dom";

export default function SiteHeader() {
  return (
    <>
      <div className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="brand">
            <svg className="brand-mark" width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
              <rect x="4" y="13" width="24" height="15" rx="2" fill="#FF3B30" />
              <rect x="4" y="6" width="24" height="7" rx="1" fill="#FFD23F" />
              <g stroke="#0A0B0F" strokeWidth="3">
                <line x1="4" y1="13" x2="8" y2="6" />
                <line x1="11" y1="13" x2="15" y2="6" />
                <line x1="18" y1="13" x2="22" y2="6" />
                <line x1="25" y1="13" x2="28" y2="7" />
              </g>
            </svg>
            Reel Cut
          </Link>
          <div className="live-indicator">
            <span className="live-dot" aria-hidden="true" />
            Engine live
          </div>
        </div>
      </div>
      <div className="sprocket-strip" aria-hidden="true" />
    </>
  );
}