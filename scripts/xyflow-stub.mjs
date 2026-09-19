// Minimal stand-in for @xyflow/react used only so esbuild can tree-shake the
// full React-based library out of the headless diagram engine bundle. The
// createDocumentFromWebMCP / validateDiagramVisualGrammar graph references only
// the MarkerType enum values; the rest of these exports exist so any incidental
// import in the traced module graph resolves to an inert value instead of
// dragging React in. If a future editor release makes the engine depend on real
// xyflow runtime behavior, the engine build will surface it here rather than
// silently shipping a broken bundle.
export const MarkerType = { Arrow: "arrow", ArrowClosed: "arrowclosed" };
export const Position = { Left: "left", Top: "top", Right: "right", Bottom: "bottom" };
export const Handle = null;
export const NodeResizer = null;
export const getNodesBounds = () => ({ x: 0, y: 0, width: 0, height: 0 });
export const getViewportForBounds = () => ({ x: 0, y: 0, zoom: 1 });
