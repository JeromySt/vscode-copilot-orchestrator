/**
 * @fileoverview Zoom and pan controls for plan detail view.
 *
 * @module ui/templates/planDetail/scripts/zoomPan
 */

/**
 * Generate JavaScript for zoom/pan mouse handlers.
 *
 * @returns JavaScript code string.
 */
export function renderZoomPan(): string {
  return `
    // ── Zoom / Pan Controls ─────────────────────────────────────────────
    var currentZoom = 1;
    var minZoom = 0.1;
    var maxZoom = 3;
    var zoomStep = 0.1;
    
    function updateZoom() {
      const container = document.getElementById('mermaidContainer');
      const zoomLabel = document.getElementById('zoomLevel');
      if (container) {
        container.style.transform = 'scale(' + currentZoom + ')';
        
        // Adjust container size to match scaled content (prevents empty space when zoomed out)
        const svg = container.querySelector('svg');
        if (svg) {
          const naturalWidth = svg.getBBox().width + 20;
          const naturalHeight = svg.getBBox().height + 20;
          container.style.width = (naturalWidth * currentZoom) + 'px';
          container.style.height = (naturalHeight * currentZoom) + 'px';
        }
      }
      if (zoomLabel) {
        zoomLabel.textContent = Math.round(currentZoom * 100) + '%';
      }
    }
    
    function zoomIn() {
      currentZoom = Math.min(maxZoom, currentZoom + zoomStep);
      updateZoom();
    }
    
    function zoomOut() {
      currentZoom = Math.max(minZoom, currentZoom - zoomStep);
      updateZoom();
    }
    
    function zoomReset() {
      currentZoom = 1;
      updateZoom();
    }
    
    function zoomFit() {
      const diagram = document.getElementById('mermaid-diagram');
      const container = document.getElementById('mermaidContainer');
      if (!diagram || !container) return;
      
      const svg = container.querySelector('svg');
      if (!svg) return;
      
      // Reset to 1 to measure natural size
      currentZoom = 1;
      container.style.transform = 'scale(1)';
      
      const diagramWidth = diagram.clientWidth - 32; // Account for padding
      const svgWidth = svg.getBoundingClientRect().width;
      
      if (svgWidth > diagramWidth) {
        currentZoom = diagramWidth / svgWidth;
      }
      updateZoom();
    }
    
    // Mouse wheel zoom (no modifier needed when over diagram)
    const diagramEl = document.getElementById('mermaid-diagram');
    diagramEl?.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }, { passive: false });
    
    // Mouse drag to pan
    let isPanning = false;
    let didPan = false;
    let panStartX = 0;
    let panStartY = 0;
    let scrollStartX = 0;
    let scrollStartY = 0;
    
    diagramEl?.addEventListener('mousedown', (e) => {
      // Only pan on left mouse button, and not on interactive elements
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest('.zoom-controls, .legend, button, a')) return;
      
      isPanning = true;
      didPan = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = diagramEl.scrollLeft;
      scrollStartY = diagramEl.scrollTop;
      diagramEl.classList.add('panning');
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isPanning || !diagramEl) return;
      
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      
      // Mark as panned if moved more than 5px (distinguish from click)
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        didPan = true;
      }
      
      diagramEl.scrollLeft = scrollStartX - dx;
      diagramEl.scrollTop = scrollStartY - dy;
    });
    
    document.addEventListener('mouseup', () => {
      if (isPanning && diagramEl) {
        isPanning = false;
        diagramEl.classList.remove('panning');
      }
    });
    
    // Suppress click after pan
    document.addEventListener('click', (e) => {
      if (didPan) {
        e.stopPropagation();
        e.preventDefault();
        didPan = false;
      }
    }, true); // Use capture phase to intercept before other handlers
    
    // Also stop panning if mouse leaves the window
    document.addEventListener('mouseleave', () => {
      if (isPanning && diagramEl) {
        isPanning = false;
        diagramEl.classList.remove('panning');
      }
    });
  `;
}
