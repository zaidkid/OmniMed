"use client";

import Shell from "../../components/Shell";
import KnowledgeGraphPanel from "../../components/omnimed/KnowledgeGraphPanel";

export default function KnowledgeGraphPage() {
  return <Shell><main style={{ minHeight: "100%", background: "#F5FAFF", padding: "28px 24px" }}><div style={{ maxWidth: 1500, margin: "0 auto" }}><KnowledgeGraphPanel /></div></main></Shell>;
}
