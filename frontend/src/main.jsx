import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home.jsx";
import JobStatus from "./pages/JobStatus.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <SiteHeader />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/jobs/:jobId" element={<JobStatus />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);