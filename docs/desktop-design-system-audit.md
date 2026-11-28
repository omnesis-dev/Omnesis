# Desktop design verification audit

Read [the design system](desktop-design-system.md) for the actual component and token conventions.

This ledger separates implemented presentation from measured evidence. A test or
preview's existence does not establish that its current implementation passed.
Keep all application behavior, required setup, permission repair, authorization
and explicit confirmation semantics intact while changing presentation.

## Evidence levels

- Logic tests check token resolution and meaningful behavior without claiming a rendered window.
- Component rasters check composed content; they do not establish visible native chrome or active controls.
- Owned window captures require the exact app/window owner, real geometry, current appearance and active-state assertions.
- External UI and assistive technology checks establish keyboard and VoiceOver behavior separately.

A failed capture remains a failure. Do not replace it with a component raster,
remove foreground assertions, widen functional deadlines or infer permission or
session causes from a capture error.

## Acceptance ledger

The rows below distinguish partial component evidence from final acceptance. Update
individual rows with exact source, test result and inspected artifact evidence;
do not mark the ledger complete from a passing subset.

| Area                                           | Required evidence                                                      | Useful existing fixture families                                               | Current verification                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1. Objective                                   | Whole native redesign preserving behavior                              | DesktopTheme; DesktopRenderTests                                               | Implemented; partial component evidence; acceptance open                                                    |
| 2. Overall design philosophy                   | Quiet native productivity aesthetic                                    | Native NavigationSplitView/Form/Settings/NSMenu                                | Light/Dark components inspected; native shell open                                                          |
| 3. Scope and implementation constraints        | Inspect/reuse architecture; presentation-only changes                  | Native view and AppKit adapter inventory with shared adaptive foundations      | Source reviewed; full behavioral gate open                                                                  |
| 4. Color philosophy                            | Neutral semantic palettes; System default, Light/Dark live updates     | DesktopAppearance, adaptive DesktopTheme and owned-window adapter              | a0c7 palette and live appearance tests passed; full native matrix open                                      |
| 5. Surface hierarchy and visual depth          | Four restrained surface levels                                         | DesktopCardStyle/DesktopGroupBoxStyle                                          | Component hierarchy inspected; native materials open                                                        |
| 6. Native macOS window integration             | Native chrome/toolbars/materials and native controls                   | DesktopOwnedWindowChrome; minimum-library/settings; hosted sources/resize      | a0c7 minimum Library and fitted Settings window checks passed; full matrix open                             |
| 7. Sidebar design                              | Compact integrated sidebar/neutral selection/modest brand              | DesktopRootView.libraryNavigation; ready-sidebar                               | Source and row presence checked; native painting/selection open                                             |
| 8. Main content layout                         | Content-specific widths and responsive margins                         | Shared reading/form width tokens; onboarding and native settings layouts       | Empty Ask composition passed; full layout matrix open                                                       |
| 9. Typography system                           | System semantic typography, restrained weights, readable metadata      | System fonts throughout; literal-font inventory                                | Terms wrap and three-state heading regression passed; full type matrix open                                 |
| 10. Spacing system                             | 4pt spacing + meaningful grouping and density                          | VStack/HStack/Form existing primitives                                         | Representative component spacing inspected; remaining states open                                           |
| 11. Corner radius system                       | Small consistent radii; native shapes                                  | DesktopButtonStyle, grouped sections and shared Radius tokens                  | Component radii inspected; native window and 2× open                                                        |
| 12. Borders, separators and shadows            | Subtle borders/separators/shadows, sharp1x/2x                          | Card stroke1/2; native chrome test framework                                   | Logical focus contrast corrected; complete native focus proof open                                          |
| 13. Iconography                                | SF Symbols/brand asset consistent sizes; labelled icon controls        | BrandAssetTests; MenuBarImageTests; toolbar identifiers/help                   | Brand/components inspected; full native input proof open                                                    |
| 14. Buttons                                    | Primary/secondary/ghost/destructive coherent control states            | DesktopButtonStyle; existing action tests                                      | a0c7 Light/Dark action, disabled and input-focus checks passed; full state matrix open                      |
| 15. Inputs and form controls                   | Native neutral inputs/labels/errors; focus                             | Native TextField/SecureField/Picker/Toggle; SourceSetup/Connections tests      | Onboarding label/action cases passed; complete input state matrix open                                      |
| 16. Composer and large text entry components   | Refined bounded composer; stable multiline/focus/readability           | AskView; ChatLayoutTests; AskState; HostedChatFlow; Intents                    | Empty Ask Light/Dark composition passed; active chat open                                                   |
| 17. Empty states                               | Intentional factual empty states                                       | Render ask/search/devices/sources empty; ContentUnavailableView                | Representative empty states inspected; full state matrix open                                               |
| 18. Lists and rows                             | Shared scanable rows; subtle hover vs selection; keyboard actions      | Native List sources/devices/search/history; source policy tests                | Selected source states exercised; keyboard/hover/selection open                                             |
| 19. Cards and grouped content                  | Selective cards/flat settings                                          | GroupBox globally DesktopGroupBoxStyle                                         | Flat sections inspected; native material integration open                                                   |
| 20. Settings and configuration interfaces      | Orderly native settings, actual options retained                       | SettingsView7tabs; minimum-settings; prerequisite-order tests                  | a0c7 fitted Settings native tabs, scrolling and repair checks passed; full settings matrix open             |
| 21. Status indicators and feedback             | Compact factual status/errors/progress; important requirements visible | SetupBanner/StoreRefresh/PrerequisiteMonitor/SourceHealth tests                | Representative truthful states inspected; full error/progress matrix open                                   |
| 22. Popovers, menus and dialogs                | Native popovers/menus/dialogs, safe defaults                           | omnesisSheet; NSOpenPanel/NSSavePanel; StatusMenuTests; restore/recovery flows | Recovery/removal components inspected; true sheet geometry open                                             |
| 23. Interaction state system                   | Reusable rest/hover/pressed/selected/focus/disabled/loading/error      | DesktopButtonStyle; native List/Form; source actions                           | a0c7 Light/Dark mounted action/input-focus checks passed; pointer/pressed/full keyboard open                |
| 24. Animation and motion                       | Purposeful motion; respect Reduce Motion                               | No explicit animation/withAnimation/scaleEffect in current product inventory   | Source reviewed; native accessibility preferences remain open                                               |
| 25. Responsive desktop layout                  | Resizable desktop, min/typical/wide/fullscreen and scale resilience    | 860x600 minimum Library;720x600 fitted Settings; Ask resize; source sheets     | a0c7 minimum Library/fitted Settings passed at1×; full minimum/resize/fullscreen/2× matrix open             |
| 26. Accessibility                              | AA contrast; VoiceOver/keyboard/system a11y, noncolor state            | desktopContrast env; ask-increased-contrast; AX driver/action tests            | a0c7 logical role contrast passed; representative calibrated helper AA; full rendered/assistive checks open |
| 27. Brand identity                             | Existing brand; limited accent and no visual cliches                   | Vector OmnesisMark/MenuMark BrandAssetTests                                    | Unboxed light/dark template inspected; native sidebar open                                                  |
| 28. Design system architecture                 | Simple centralized reusable design primitives                          | Theme/Controls/omnesisSheet/NativeChrome existing seams                        | Shared foundations implemented and source-reviewed                                                          |
| 29. Design system documentation                | Practical implementation-specific docs                                 | macos/README.md and docs/desktop.md                                            | Independent documentation/source audit passed; whole-app conformance open                                   |
| 30. Component previews and visual verification | Development-only previews of needed variants/states                    | DesktopDesignPreviews shared-control variants plus root/source/server previews | Partial component rasters inspected; full verification matrix open                                          |
| 31. Performance and implementation quality     | Responsive native implementation, efficient scroll, no heavy effects   | Native List/LazyVStack; Ask scroll ownership tests; NSViewRepresentable seams  | Source reviewed; full-state responsiveness remains open                                                     |
| 32. Visual anti-patterns to eliminate          | Remove listed visual anti-patterns without hiding functionality        | Theme/Root/Card/Controls/font/color inventory                                  | Neutral components inspected; native shell acceptance open                                                  |
| 33. Reference mockup interpretation            | Interpret reference as aesthetic only                                  | Existing destination6/settings7 and real provider metadata                     | Reference used without adding mockup-only features                                                          |
| 34. Implementation approach                    | Audit→foundations→shell→components→all screens→verify→docs             | This baseline inventory and semantic native tests                              | Audit/foundations/shell/screens implemented; verification ongoing                                           |
| 35. Acceptance criteria                        | All acceptance categories fulfilled with honest evidence               | Existing source/test apparatus, current activation diagnosis                   | Not accepted; measured gaps remain                                                                          |
| 36. Design decision-making principles          | Correctness/native/a11y before minimalism                              | Required setup, permission repair, saved artifact/consent tests                | Behavior-preserving source review complete; full gates open                                                 |
| 37. Expected final deliverables                | Implemented result and concise final proof/limitations/docs            | Implemented redesign and this scoped evidence ledger                           | Implemented; final delivery pending complete evidence                                                       |

## Current source and execution order

Adaptive semantic colors, the System/Light/Dark preference, shared type/spacing/
radius/control tokens and shell migration are implemented. The independent
palette oracle uses appearance-specific expected values rather than reading
expected colors from production tokens. The renderer isolates preferences and
invokes callbacks exactly twice for explicit light and dark; System transitions
are separate tests. Scoped results below do not establish whole-app acceptance.

Suggested admitted hosted selectors, in this order:

1. `DesktopDesignSystemTests`: independent palette rejection, role contrast,
   private preference updates, inherited System transitions and owned control semantics.
2. `DesktopColorReferenceTests`: native/SwiftUI bitmap and whole-window pipeline
   calibration, including black/white/ink, alpha and wrong-input rejection.
3. `DesktopRenderTests`: application shell, welcome/setup, empty Ask, fitted main
   and settings windows, mandatory repairs and existing error states.
4. `DesktopSourceSetupTests`, `CollectionAccessFlowTests`,
   `DesktopConnectionsTests`, `NearbyConnectionTests`: real source/permission/
   approval/error flows, including provider-owned guide states.
5. `DesktopHostedChatFlowTests`, `DesktopAskStateTests`,
   `DesktopSearchDocumentTests`, `DesktopIntentsTests`: populated conversation,
   scrolling, sources/documents, focus and preserved no-auto-send behavior.
6. Settings-specific recovery/restore/update/storage/model and status-menu
   suites, followed by the full affected gate and external UI/assistive checks.

Selectors describe scope, not authorization to bypass admission, prerequisites,
source freezing or full affected validation. Rendered active-window failures
remain separate from logic checks and cannot be treated as visual acceptance.
All required screen families and unperformed preference/display/keyboard/
VoiceOver checks remain in the ledger even if an early selector passes.

## Measured results and remaining gaps

### Scoped a0c7 Intel CI results

The Intel job for source `a0c7f4ba22b4607090bb9f64bd179f12eb30c954`
(run 46084092859, job 140789895107, artifact 15241483487) completed all seven
`DesktopDesignSystemTests`, both `DesktopColorReferenceTests` and all 26
`DesktopRenderTests` methods successfully. These terminal results supersede the
earlier local capture failures described below for those exact method scopes;
they do not erase the failures in those earlier runs.

The foundation checks prove the independent palette oracle, logical role contrast,
private preference changes on the same window, live inherited System changes,
explicit preference isolation, and mounted controls in both appearances. Actual
native accessible actions, enabled/disabled roles, owned text-editor focus,
multiline containment and separate adjacent actions passed. This is not complete
keyboard traversal, pointer-state or VoiceOver qualification.

Owned receipts for `design-controls`, `design-multiline-controls`,
`minimum-library` and `minimum-settings` in both appearances record successful
image writing, exact window/process ownership, active/key/frontmost status,
on-screen presence and matching canvas. The minimum Library and fitted Settings
checks retain native chrome/control containment, required-repair reachability,
and actual Settings tab actions and form scrolling. The eight native-window images for these four paired cases were inspected:
focused filled input, enabled/disabled buttons, naturally wrapped multiline row,
ordinary minimum Sources and fitted Settings with readable tabs and reachable
repair actions. Their chrome is active in the receipts and visible in the images.
This inspection is limited to those artifacts. The color-reference receipt
records backing scale 1 and validates both cache and native-window samples.
The increased-contrast Ask case remains component evidence, as its capture scope
explicitly states; it does not establish OS preference or full-screen qualification.

These results belong to the a0c7 source, not subsequent follow-ups. At the later
reviewed revision, Theme, Appearance, tokens, renderer and the three suites remain
byte-identical; Controls adds only textual Link presentation. At that checkpoint,
new Link, error, startup, source-picker, scroll and intent follow-ups had not yet
been validated. The next subsection records their later scoped results.
The subsequent section-inset and dialog-spacing migration uses existing shared
tokens, and the General form keeps the Appearance picker's persistent label
without repeating it as a section heading. These presentation refinements also
require inspection of their own rendered output.
The same Intel job contains one Core failure, four other hosted failures and five
external-UI failures. It is not a full native pass. Full screen/state/display-scale,
keyboard/VoiceOver, pointer and packaged-app acceptance remain open.

### Scoped 0b23 follow-ups

Source `0b23cac0acf1b87596b50ee38b7f3eb428a0cded` executed in Intel job
140821414762 of run 46094023828 (artifact 15244176021). All 14 onboarding UX,
14 automatic-startup and 50 source-setup methods passed. The inspected 26
component images (13 Light/Dark pairs) show distinguishable textual links, error explanations before
retry, factual historical-source guidance without an empty picker, and startup
action hierarchy. These are component and mounted-control proofs, not packaged
permission or whole-window qualification.

Inspection also found that checking and unavailable startup states still used
copy implying startup was disabled or unapproved. Their correction retains the
required prerequisite while describing its status as unverified; the revised
copy and explicit per-status expectations await new native verification.

Both gesture-driven scroll cases and one retired-context intent case still
failed; the no-wheel streaming control passed across its complete size/growth
matrix. Gesture receipts show live scrolling continued after the fixture's
packet-delivery checkpoint. Preparation now requires the owned live-scroll end
within the existing deadline, retaining the subsequent physical assertions.
The intent diagnostic identifies a readiness-predicate deadline, not an HTTP
timeout; further fixed-label clause facts retain its original checks. These
follow-ups need execution before any failure is considered resolved.

The Intel Core suite passed all 334 tests, while its hosted suite had three
failed methods and all five external UI queries failed. This remains a failing
native job; neither successful components nor Core establish full acceptance.

Additional source and device actions now carry contextual accessibility names.
Reauthentication names its already-resolved reporting computer, including a
single legacy report without a device ID; ambiguous reports gain no inferred
repair action. Source settings binds Escape to its existing Done action while
retaining the busy guard. The subsequent Intel source-health and source-setup
suites passed, including the mounted contextual repair actions. Physical Escape
and VoiceOver behavior remain unverified.

The automatic recovery-copy confirmation now bounds its variable details in a
scrolling area while retaining compact short content. The heading, explicit
consent and original actions stay outside that area. New actual-window fixtures
exercise compact and long valid previews, the native scroll extent, reachable
footer controls and consent without removal. The subsequent attached-sheet
execution and inspected captures are recorded below; the ordinary fixture's
viewport correction still needs execution.

Runtime interaction sheets also bound long messages and choices while keeping
comparison codes beside their original warning and approval. The existing Cancel
and browser-completion actions stay reachable. Compact, long and code-only body
fixtures use the production presenter in both appearances. Their code compiled;
native execution and capture inspection remain pending.

Recovery protection bounds its variable states and full errors while keeping
the heading and existing dismissal action visible. Recovery code masking,
save confirmations, expiry and cancellation guards remain intact. Eighteen
paired cases mount the actual recovery view through the shared sheet wrapper
with status requests disabled. These qualify neither the production root's
status request nor file dialogs or runtime cancellation. Their code compiled;
native execution and capture inspection of this follow-up remain pending.

Account-move consent keeps a compact heading and fixed actions, with complete
account, destination and permission details in a bounded scrolling body. The
move action's accessible name includes the destination. Sixteen paired wrapper
cases cover long names and access requirements, enabled and paused sources,
busy controls and keeping the current connection without dispatching a move,
at Library and fitted Settings parent sizes.
Their code compiled; native execution and capture inspection remain pending. These
fixtures do not qualify source discovery or the production setup presenter.

Phone pairing keeps its title and Done/Create actions outside bounded variable
content. Sixteen paired wrapper cases cover compact, active-code, large-roster
and issuance-error states at Library and fitted Settings sizes. The cases use
an owned HTTP fixture and require the issued code's withdrawal after Done;
they do not qualify real phone redemption or Devices navigation. Their code
compiled; native execution and capture inspection remain pending.

Removal keeps the current state's actions outside bounded details. Erase-mode
plan matching, confirmations and system cleanup guards are unchanged. Sixteen
paired wrapper cases cover compact states, complete long errors, completed
removal and pending key cleanup at Library and fitted Settings sizes. The cases
never invoke removal, Login Items changes or Trash. Their compilation, native
execution and capture inspection remain pending.

The subsequent Intel run passed all 338 Core tests and both physical-scroll
cases after the completed-gesture precondition. Its production-attached recovery
copy test passed; four owned compact/long Light/Dark sheet captures were
inspected with matching active, key, frontmost and on-screen receipts. These show
the bounded details with consent and actions outside the scroller. The ordinary
window fixture failed eight viewport assertions by shrinking to the dialog's
natural height. Its test-only host now keeps the requested outer viewport,
with the original assertions and privacy regressions preserved; execution of
that correction is pending. Intent and external accessibility failures remain
unresolved, so this is not a passing native job or complete design acceptance.

Draft action callbacks now bind their observed context and request before
changing the chat or consuming a queued action. Eight non-window cases use the
actual production handler and real Store/Router/Chat APIs, with refused HTTP and
runtime startup disabled. The old-behavior control executed all eight cases:
five stale-callback cases failed with 23 assertions while three valid cases
passed. The fixed snapshot passed all eight, with zero failures or skips
(510.1s queue wait / 297.6s run; test suite 0.248s). These are non-window state
results, including execution under a reported screen shield.
This addresses stale observed identities; it does not establish the cause of
the mounted retired-question mismatch or an outgoing view's lifetime ownership.

The document reader keeps its full selectable title and content in one bounded
reading surface, with loading/error feedback before the title and Done/Open
original outside the scroller. Sixteen real-HTTP wrapper cases cover short,
long, error and held-loading states in both appearances and parent sizes;
initial status and final title-line geometry are explicit assertions. Source
review passed; native compilation, execution and image inspection are pending.

### Source follow-ups and earlier local evidence

A further inspection of the retained Light/Dark native test artifacts identified
four presentation corrections: historical sources show a factual empty state
instead of an empty computer picker; textual links use the semantic accent and
an underline; onboarding errors explain the failure before the retry action;
and background repair promotes retry only after startup is observed enabled.
The corrections retain native link activation, existing authorization checks
and explicit setup actions. Regression cases exercise the actual mounted
controls, including disabled links and both appearances. Their executed scope
is recorded above; later copy and spacing refinements remain unverified.
These additions do not establish complete visual acceptance.

Scroll-target observations and a bounded intent-retirement failure journal
distinguish outstanding native test failures without changing production scroll
decisions, relaxing assertions or extending deadlines. The intent fixture also
waits for its existing owned-editor focus condition before asserting readiness.
These are diagnostic and test-observation changes, not evidence that the
underlying native failures have been resolved.

The app and hosted test bundle compiled for the scoped native runs below.
`DesktopOnboardingUXTests` passed all eleven methods with zero failures in its latest
selected run. This includes complete terms copy and bounded wrapping, persistent
labels, required setup and repair actions, and the three distinct Waiting states.
The Waiting regressions retain the exact copy/action/fit contract and compare
public accessibility text-range geometry, using the already-checked full label
or value as text authority. All ten preceding methods remain intact. The
disconnected and stopped states share a leading axis with their headings and
actions; actual accessibility frames verify their compact grouping in both
appearances. Paired component images were inspected after that refinement.
Inspected Light/Dark terms components show the full final sentence. A joined-account
presentation fixture is robustness coverage, not evidence that production joined
enrollment uses the home-account consent route.

An earlier local seven-method `DesktopDesignSystemTests` run passed five methods,
including both previously failing live preference/System transitions. Two methods
still failed at native ScreenCaptureKit capture. Thus actual inherited native
appearance and SwiftUI color-scheme transitions passed their scoped assertions;
this is not a seven-method pass or complete native interaction qualification.
The initial focus-contrast and undersized-probe findings were corrected, but
unperformed keyboard/pointer states remain open.

An earlier local 26-method render run passed 18 methods and failed eight, producing
40 component rasters. Its eight native capture failures remained failures; three
additional banner assertions misclassified a broad accessibility container as a
content column. The corrected check uses the actual label/action envelope while
keeping containment, native-control, action and detail-position assertions.
Capture reported ScreenCaptureKit error -3811; no permission or session cause was
established. Additional visibility facts do not change capture behavior.

The visible-window helper caches its component image, runs its validation
callback, then captures the native window. In that earlier local run, the first Aqua control-action,
input-focus and multiline-layout subphases therefore executed before capture
failed; failure prevented the second appearance and final cumulative assertions.
These subphases are partial evidence, not a passing test or active-window proof.
A cached component also precedes state changes made in its callback, so it is not
an independently reset filled-state screenshot.

The explanatory backup-recovery text was measured in representative component
images after conversion from each embedded ICC profile to sRGB. Corrected Light
and Dark normal-text contrast ratios were approximately 6.88:1 and 8.88:1; the
old Light sample was approximately 2.80:1. Raw device RGB was not a valid WCAG
measurement. These calibrated results establish those specific text/background
samples, not every one of the 38 changed explanatory Text sites, control states,
physical displays or native materials. Native control/disabled styling was not
repainted by those Text-only substitutions.

The previous affected gate did not pass. Its full unit phase exposed an absent
ignored, pinned DuckDB extension asset, and the run was cancelled rather than
reported green. After restoring that exact existing cache artifact without
changing public source, the focused offline repair suites passed 51 tests with
four existing skips across two files (55 total outcomes). The earlier separate
full production typecheck and scoped lint passed; neither proves completion of
the cancelled affected gate, nor qualifies the newer native follow-ups. A fresh
authoritative affected gate remains required for the final coherent source.

Representative Light/Dark components were inspected for typography, brand,
composition, statuses, forms and removal/recovery presentation. Native sidebar
materials and tabs omitted by component caching establish neither a product
rendering defect nor successful integration. The a0c7 scoped native-window results
above supersede the earlier local capture failures for those exact cases. Remaining
live appearance/control states, keyboard/VoiceOver, pointer states, real sheet
geometry and the full size/display-scale matrix remain open. No full native or
full affected-gate pass is claimed.

## Coverage dimensions

Use supported minimum windows, a typical laptop window and a wide fitted window.
The main window currently declares an 860 × 600 point minimum; settings declares
640 × 500 points. Existing 1080 × 740 and 720 × 600 point fixtures are useful
starting points. Cover fullscreen, expanded/collapsed sidebar, long labels,
scrollable lists, multiline content, native sheets and default/cancel actions.
Record actual backing scale for 1× and 2× evidence; resizing a bitmap is not a
physical display test.

Capture explicit light and dark appearances and separately change the app-local
System test environment in the same owned window. Use private `UserDefaults`
stores and local environment overrides; tests must not write the operator's
appearance or accessibility settings. Record native effective appearance and
resolved colors, rather than relying on screenshot filenames.

Shared controls need default, hover, pressed, selected, focus, disabled and
applicable loading/error cases. Require normal text contrast of at least 4.5:1,
large text at least 3:1, and readable control boundaries/focus. Include Increase
Contrast, Reduce Motion and Reduce Transparency. Native progress must remain
truthful and meaningful status must include text or shape, not color alone.

AX action dispatch does not establish keyboard tab order or VoiceOver navigation.
Check Tab/Shift-Tab, Space, Return, Escape, existing shortcuts, menu navigation,
labels, roles, values and logical order separately. Never request production
permissions from a visual fixture.

## Fixture ownership

Existing snapshot callbacks run once per appearance. State-changing callbacks
must account for each appearance or use independent fixtures. A System transition
case must not repeat setup, authentication, authorization or destructive actions
merely to obtain another screenshot. Keep exact action-count and no-auto-send
assertions.

Start with the full screen-family matrix, then apply environment combinations to
high-risk shell, long conversation, source list, settings and modal cases. This
avoids an unnecessary full Cartesian product while retaining every screen's real
populated, loading, empty, error and required-repair states. Unperformed native
window or assistive-technology checks remain explicit limitations.
