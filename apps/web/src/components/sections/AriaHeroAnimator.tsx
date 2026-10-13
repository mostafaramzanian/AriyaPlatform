"use client";
import { useEffect } from 'react';

export default function AriaHeroAnimator() {
  useEffect(() => {
    const prefersReduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // If user prefers reduced motion, do not inject animations
    if (prefersReduce) return;

    // Inject keyframes/styles
    const style = document.createElement('style');
    style.id = 'aria-hero-anim-style';
    const baseDuration = 0.9; // seconds (between 0.8 - 1.2s)
    style.innerHTML = `
      @keyframes strokeMove { to { stroke-dashoffset: 0; } }
      @keyframes nodePulse { 0% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.06); opacity: 0.9 } 100% { transform: scale(1); opacity: 1 } }
      @keyframes flash { 0% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 } }
      .aria-flow { stroke-dasharray: 240; stroke-dashoffset: 240; animation: strokeMove ${baseDuration}s linear forwards; }
      .aria-node { transform-origin: center; animation: nodePulse ${baseDuration}s ease-in-out 0.6s infinite; }
      .aria-decision { animation: flash ${baseDuration}s ease-in-out 1.8s; }
      .aria-agent { transform-origin: left; animation: nodePulse ${baseDuration}s ease-in-out 2.7s infinite; }
    `;
    document.head.appendChild(style);

    // Add classes to SVG elements if present
    const flows = ['flow-erp-to-core', 'flow-crm-to-core', 'flow-db-to-core'];
    flows.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('aria-flow');
        // stagger by setting animation-delay
        (el as unknown as SVGElement).style.animationDelay = `${idx * 0.4}s`;
      }
    });

    const nodes = ['node-01', 'node-02', 'node-03', 'node-04'];
    nodes.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('aria-node');
        (el as unknown as SVGElement).style.animationDelay = `${idx * 0.25}s`;
      }
    });

    // decision and agent visuals
    const decision = document.getElementById('decision-engine');
    if (decision) decision.classList.add('aria-decision');
    const agents = ['agent-01', 'agent-02'];
    agents.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('aria-agent');
        (el as unknown as SVGElement).style.animationDelay = `${2.5 + idx * 0.3}s`;
      }
    });

    return () => {
      const s = document.getElementById('aria-hero-anim-style');
      if (s) s.remove();
    };
  }, []);

  return null;
}
