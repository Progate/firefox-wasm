// Painting: software RenderDocument blit, GPU/WebRender present, and popup
// compositing/overlay. Split from embed-xul.cpp. See embed-xul.h.
#include "embed-xul.h"
#include "nsRefreshDriver.h"
// Paint the current document of the persistent browser to a fresh BGRA buffer
// (width*height*4 bytes). Caller owns/free()s the buffer.
// Composite any open popups (menus, context menus, the app-menu panel, <select>
// dropdowns) onto ctx. Popups live in their own widgets and are separate display
// roots (NS_FRAME_IN_POPUP -> GetDisplayRootFrame stops at the popup), so neither
// the main window's RenderDocument nor its WebRender scene includes them; we paint
// each popup frame at its widget bounds. Our window is at (0,0), so a popup's
// widget bounds are canvas coordinates. Returns the number of popups painted.
static int composite_visible_popups(gfxContext* ctx, mozilla::PresShell* ps,
                                    int width, int height, int32_t appPerCss) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  using mozilla::dom::Document;
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (!pm) return 0;
  nsTArray<nsMenuPopupFrame*> popups;
  pm->GetVisiblePopups(popups);

  // The headless popup widget never sizes the popup frame, so a freshly-shown
  // popup comes up 0-sized; give it the window's inline size, force an intrinsic
  // reflow, then position it. CRITICAL: FlushPendingNotifications can run reflow
  // and script that DESTROYS popup frames, so we must NOT hold the raw
  // nsMenuPopupFrame* (or any entry of `popups`) across a flush -- that was a
  // use-after-free that slowly corrupted memory. Re-query GetVisiblePopups after
  // every flush, and keep the paint pass below flush-free.
  bool sized = false;
  for (auto* pf : popups) {
    if (!pf) continue;
    LayoutDeviceIntRect b = pf->CalcWidgetBounds();
    if (b.width <= 0 || b.height <= 0) {
      pf->SetSize(nsSize(width * appPerCss, height * appPerCss));
      ps->FrameNeedsReflow(pf, mozilla::IntrinsicDirty::FrameAncestorsAndDescendants,
                           NS_FRAME_IS_DIRTY);
      sized = true;
    }
  }
  if (sized) {
    if (Document* d = ps->GetDocument())
      d->FlushPendingNotifications(mozilla::FlushType::Layout);
    popups.Clear();
    pm->GetVisiblePopups(popups);  // the flush may have destroyed frames
    for (auto* pf : popups)
      if (pf) pf->SetPopupPosition(false);
    if (Document* d = ps->GetDocument())
      d->FlushPendingNotifications(mozilla::FlushType::Layout);
    popups.Clear();
    pm->GetVisiblePopups(popups);  // re-query once more before painting
  }

  // Paint pass: no flushes here, so the frame pointers stay valid for its
  // duration. GetVisiblePopups is top-to-bottom; paint back-to-front so the
  // topmost wins.
  int painted = 0;
  for (size_t i = popups.Length(); i-- > 0;) {
    nsMenuPopupFrame* pf = popups[i];
    if (!pf) continue;
    LayoutDeviceIntRect b = pf->CalcWidgetBounds();
    if (b.width <= 0 || b.height <= 0) continue;
    gfxContextMatrixAutoSaveRestore saveMatrix(ctx);
    ctx->SetMatrix(Matrix::Translation((float)b.x, (float)b.y));
    nsRegion dirty(pf->InkOverflowRectRelativeToSelf());
    // value 0 == nsDisplayListBuilderMode::Painting (avoid including the heavy
    // nsDisplayList.h, which drags in IPC/WebRender headers not on our path).
    nsLayoutUtils::PaintFrame(
        ctx, pf, dirty, NS_RGBA(0, 0, 0, 0),
        static_cast<mozilla::nsDisplayListBuilderMode>(0),
        nsLayoutUtils::PaintFrameFlags::SyncDecodeImages);
    painted++;
  }
  return painted;
}

uint8_t* xul_paint(int width, int height) {
  if (!g_docShell) return nullptr;
  uint8_t* buf = (uint8_t*)calloc((size_t)height * width * 4, 1);
  if (!buf) return nullptr;
  if (!xul_paint_into(buf, width, height)) {
    free(buf);
    return nullptr;
  }
  return buf;  // BGRA8, width*height*4 bytes
}

// Paint into a caller-owned BGRA buffer (stride width*4). Every pixel is
// written (RenderDocument fills the background first), so a buffer reused
// across frames needs no clearing.
bool xul_paint_into(uint8_t* buf, int width, int height) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  using mozilla::dom::Document;
  if (!g_docShell || !buf) return false;
  // Track the live window size: the JS side sends the current viewport dimensions
  // on every paint, so the chrome reflows to fill the window (resize support).
  EnsureSize(width, height);
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) {
    printf("xul_paint: no PresShell\n");
    return false;
  }
  ps->UnsuppressPainting();
  if (Document* doc2 = ps->GetDocument()) {
    doc2->FlushPendingNotifications(mozilla::FlushType::Layout);
  }

  int32_t stride = width * 4;
  RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
      BackendType::SKIA, buf, IntSize(width, height), stride,
      SurfaceFormat::B8G8R8A8);
  if (!dt) {
    printf("xul_paint: CreateDrawTargetForData failed\n");
    return false;
  }
  UniquePtr<gfxContext> ctx = gfxContext::CreateOrNull(dt);
  if (!ctx) return false;
  // The buffer is in device pixels; with layout.css.devPixelsPerPx (HiDPI) a
  // device pixel is smaller than a CSS pixel, so size the rect in device units.
  nsPresContext* pc = ps->GetPresContext();
  int32_t appPerDev = pc ? pc->AppUnitsPerDevPixel() : AppUnitsPerCSSPixel();
  nsRect r(0, 0, width * appPerDev, height * appPerDev);
  // DrawCaret: RenderDocument force-hides the text caret by default. We want it
  // visible in focused <input>/<textarea>/contenteditable. (Blinking is disabled
  // via ui.caretBlinkTime=0 in xul_init so a single snapshot never catches the
  // caret in its "off" phase.)
  // RenderDocument draws in CSS pixels (like canvas drawWindow); scale the
  // context so a CSS pixel covers devPixelsPerPx device pixels.
  if (appPerDev != AppUnitsPerCSSPixel()) {
    float cssToDev = float(AppUnitsPerCSSPixel()) / float(appPerDev);
    ctx->SetMatrix(Matrix::Scaling(cssToDev, cssToDev));
  }
  ps->RenderDocument(r, RenderDocumentFlags::DrawCaret, NS_RGB(255, 255, 255),
                     ctx.get());
  ctx->SetMatrix(Matrix());

  // Composite open popups onto the same buffer (no-op when nothing is open).
  composite_visible_popups(ctx.get(), ps, width, height, appPerDev);
  return true;
}

// How many paints the refresh driver has started (its last transaction id).
// It moves whenever Gecko painted the window on its own (a CSS animation, a
// smooth-scroll step, a caret blink, a load), so a caller that paints with
// xul_paint_into can repaint exactly when something changed instead of on a
// fixed timer. Popups and in-process content documents share the root's
// refresh driver, so their paints move it too.
uint64_t paint_generation() {
  if (!g_docShell) return 0;
  mozilla::PresShell* ps = g_docShell->GetPresShell();
  nsPresContext* pc = ps ? ps->GetPresContext() : nullptr;
  nsRefreshDriver* rd = pc ? pc->RefreshDriver() : nullptr;
  return rd ? rd->LastTransactionId().mId : 0;
}

// Whether something may look different from the last paint: the refresh
// driver has a paint scheduled, or style or layout is dirty (a hover change is
// only a pending restyle until the next tick turns it into a paint).
bool paint_pending() {
  if (!g_docShell) return false;
  mozilla::PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return false;
  if (ps->NeedStyleFlush() || ps->NeedLayoutFlush()) return true;
  nsPresContext* pc = ps->GetPresContext();
  nsRefreshDriver* rd = pc ? pc->RefreshDriver() : nullptr;
  return rd && rd->IsPaintPending();
}

// Composite the open popups onto a caller-owned BGRA buffer (stride width*4)
// that already holds the window's frame. For an embedder that takes the main
// window's pixels from the compositor (popups have their own widgets, so the
// compositor's frame never contains them). Returns how many were painted.
int paint_popups_into(uint8_t* buf, int width, int height) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  if (!g_docShell || !buf) return 0;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return 0;
  RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
      BackendType::SKIA, buf, IntSize(width, height), width * 4,
      SurfaceFormat::B8G8R8A8);
  if (!dt) return 0;
  UniquePtr<gfxContext> ctx = gfxContext::CreateOrNull(dt);
  if (!ctx) return 0;
  nsPresContext* pc = ps->GetPresContext();
  int32_t appPerDev = pc ? pc->AppUnitsPerDevPixel() : AppUnitsPerCSSPixel();
  return composite_visible_popups(ctx.get(), ps, width, height, appPerDev);
}

bool popups_visible() {
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (!pm) return false;
  nsTArray<nsMenuPopupFrame*> popups;
  pm->GetVisiblePopups(popups);
  return !popups.IsEmpty();
}

// The main window's widget (the one whose compositor frame is the window).
nsIWidget* main_widget() {
  if (!g_docShell) return nullptr;
  mozilla::PresShell* ps = g_docShell->GetPresShell();
  nsPresContext* pc = ps ? ps->GetPresContext() : nullptr;
  return pc ? pc->GetRootWidget() : nullptr;
}

// Paint now rather than at the next refresh tick when input invalidated
// something: the compositor then renders the change up to one vsync interval
// (16 ms) sooner. The tick still runs its own paint afterwards; with nothing
// changed in between, WebRender's retained display list makes that one cheap.
void paint_now_if_pending() {
  if (!g_docShell) return;
  mozilla::PresShell* ps = g_docShell->GetPresShell();
  nsPresContext* pc = ps ? ps->GetPresContext() : nullptr;
  RefPtr<nsRefreshDriver> rd = pc ? pc->RefreshDriver() : nullptr;
  if (rd && rd->IsPaintPending() && !rd->IsInRefresh()) rd->PaintIfNeeded();
}

// GPU mode (GECKO_GPU=1): the in-process WebRender compositor presents directly to
// the page <canvas> via WebGL. We do NOT paint per frame here -- instead we make
// sure the compositor is active + correctly sized and let the refresh driver (driven
// by the command loop's event-loop pump, at the top-level-always-active full frame
// rate) build the WebRender display list and present ON ITS OWN whenever content
// invalidates (loads, hovers, CSS/JS animations). A one-time SchedulePaint (and one
// after each resize) kicks the pipeline; steady-state static frames then cost nothing
// (no forced per-frame PaintSynchronously). Idempotent; cheap to call each tick.
void gpu_ensure_active(int width, int height) {
  using namespace mozilla;
  if (!g_docShell) return;
  EnsureSize(width, height);  // track the live window size (resize support)
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return;
  // Clear the gates that keep a windowless browser from painting (one-time, cheap to
  // re-assert): never-painting, inactive (top-level-always-active forces active),
  // suppressed painting.
  ps->SetNeverPainting(false);
  ps->ActivenessMaybeChanged();
  ps->UnsuppressPainting();
  bool resized = false;
  nsPoint offset;
  nsIWidget* widget = nsContentUtils::GetWidget(ps, &offset);
  if (widget) {
    if (!widget->IsVisible()) widget->Show(true);
    // The windowless widget starts at an empty rect; size it to the canvas so the
    // compositor surface (WebRender framebuffer) matches.
    LayoutDeviceIntRect b = widget->GetBounds();
    if (b.width != width || b.height != height) {
      widget->Resize(mozilla::DesktopSize((float)width, (float)height), true);
      resized = true;
    }
  }
  // Kick the WebRender display-list rebuild once (and after a resize). SchedulePaint
  // sets NS_FRAME_UPDATE_LAYER_TREE on the display root; the refresh driver then
  // paints + composites on its next tick -- and on every later content invalidation
  // -- so the main scene presents without a per-frame forced paint.
  static bool kicked = false;
  if (!kicked || resized) {
    kicked = true;
    if (nsIFrame* root = ps->GetRootFrame()) root->SchedulePaint();
  }
}

// GPU mode: popups are kept off the GPU (their widgets use the fallback renderer
// via HeadlessWidget::ShouldUseOffMainThreadCompositing) so they never present to
// the single page <canvas> and fight the main window's compositor. Instead we
// paint the visible popups here into a transparent, canvas-sized BGRA buffer that
// the JS side draws onto a 2D overlay canvas stacked over the WebGL canvas. Returns
// null when no popup is open, which tells JS to clear the overlay.
//
// OWNERSHIP: the returned buffer MUST be a fresh heap allocation -- the command
// loop stores it in g_cmd->result and free()s g_cmd->result at the start of the
// next command. A previous version returned a reused static buffer, which the loop
// then free()d every frame: gpu_present's PaintSynchronously/PumpEvents reallocated
// into that freed region, the next frame memset+painted into it (use-after-free)
// and re-freed it (double-free), corrupting the heap. The fault surfaced far away
// (e.g. the GC write barrier hitting "unreachable") and only in GPU mode, since the
// software path (xul_paint) already calloc's a fresh buffer each frame.
uint8_t* paint_popup_overlay(int width, int height) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  if (!g_docShell) return nullptr;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return nullptr;
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (!pm) return nullptr;
  nsTArray<nsMenuPopupFrame*> popups;
  pm->GetVisiblePopups(popups);
  if (popups.IsEmpty()) return nullptr;  // nothing open -> JS clears the overlay

  size_t need = (size_t)width * (size_t)height * 4;
  if (need == 0) return nullptr;
  uint8_t* buf = (uint8_t*)calloc(need, 1);  // zero == fully transparent backdrop
  if (!buf) return nullptr;

  int32_t stride = width * 4;
  RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
      BackendType::SKIA, buf, IntSize(width, height), stride,
      SurfaceFormat::B8G8R8A8);
  if (!dt) { free(buf); return nullptr; }
  UniquePtr<gfxContext> ctx = gfxContext::CreateOrNull(dt);
  if (!ctx) { free(buf); return nullptr; }
  int n = composite_visible_popups(ctx.get(), ps, width, height,
                                   AppUnitsPerCSSPixel());
  if (n <= 0) { free(buf); return nullptr; }  // popups vanished mid-paint
  return buf;  // caller stores in g_cmd->result and free()s it next command
}

// Run the event loop briefly so any handlers/microtasks fired by an input event
// settle (and async layout updates land) before we repaint. Uses pending-event
// processing rather than SpinEventLoopUntil so it can't block waiting for an
// event that never comes.
void PumpEvents() {
  NS_ProcessPendingEvents(nullptr, PR_MillisecondsToInterval(30));
  if (g_docShell) {
    if (mozilla::PresShell* ps = g_docShell->GetPresShell()) {
      if (auto* d = ps->GetDocument()) {
        d->FlushPendingNotifications(mozilla::FlushType::Layout);
      }
    }
  }
}
