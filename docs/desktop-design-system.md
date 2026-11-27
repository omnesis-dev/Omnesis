# Desktop design system

Omnesis uses a quiet native macOS interface: neutral structural surfaces,
readable system typography and blue reserved for actions, focus and limited
emphasis. Navigation, content and floating presentations have distinct purposes;
they do not each need an outlined card. Required setup and permission repair
remain explicit even when the presentation is compact.

## Implementation

The presentation foundation is in `macos/Sources/OmnesisDesktop/`:

- `DesktopTheme.swift`: paired semantic colors, owning-window appearance,
  native sheet backgrounds, group sections and occasional cards.
- `DesktopDesignTokens.swift`: typography, spacing, radius, icon, control,
  layout and motion values.
- `DesktopControls.swift`: primary, neutral secondary, icon and destructive
  button states using the button's existing role.
- `DesktopAppearance.swift`: System, Light and Dark preference and picker.
- `DesktopDesignPreviews.swift`: development-only component previews.

Use semantic values instead of local hex colors. A color's purpose stays stable
when appearance or contrast changes; its literal RGB value does not. SwiftUI
and native window backgrounds resolve the same adaptive color pairs. The
appearance preference is local presentation state, separate from library
configuration and permissions. System clears the owning window's explicit
appearance so macOS can change it live. Do not set the application's global
appearance or force a color scheme inside an individual screen.

This follows Apple's presentation-scoped
[`preferredColorScheme`](<https://developer.apple.com/documentation/swiftui/view/preferredcolorscheme(_:)>)
model and the guidance to check colors in light, dark and increased-contrast
contexts in [Color](https://developer.apple.com/design/human-interface-guidelines/color)
and [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode).

## Palette and surfaces

| Purpose            | Light     | Dark      |
| ------------------ | --------- | --------- |
| Window canvas      | `#FAFAFB` | `#13161B` |
| Sidebar            | `#F0F1F3` | `#1B1E24` |
| Secondary surface  | `#F5F6F8` | `#191D23` |
| Elevated component | `#FFFFFF` | `#22262D` |
| Hover              | `#E8EBEF` | `#282D35` |
| Selected           | `#E0E5ED` | `#303640` |
| Pressed            | `#D7DDE7` | `#343B46` |
| Primary text       | `#20242B` | `#F0F2F5` |
| Secondary text     | `#505864` | `#B0B6C0` |
| Tertiary text      | `#58616D` | `#A0A7B2` |
| Decorative only    | `#969DA8` | `#626A77` |
| Subtle border      | `#DEE1E6` | `#2B3039` |
| Strong boundary    | `#7B8594` | `#818C9C` |
| Separator          | `#E2E5E9` | `#272C34` |
| Accent             | `#346CC5` | `#8DB8F4` |
| Accent hover       | `#285CAD` | `#A1C5F7` |
| Accent pressed     | `#204D96` | `#75A3E4` |
| Accent foreground  | `#FFFFFF` | `#101B2C` |
| Success            | `#297D62` | `#72B9A1` |
| Warning            | `#93621E` | `#D8AF72` |
| Error              | `#B83E48` | `#E58B8B` |

Tertiary text and strong boundaries intentionally differ from the initial palette
proposal to support contrast on interactive surfaces. Decorative color is never
essential text. Semantic status colors still need contrast verification against
their actual surface; use stronger primary text for selected rows when needed.
Custom focus outlines use an opaque accent for contrast; native controls retain
their system focus treatment. Increase Contrast strengthens
custom boundaries. Opaque content works with Reduce Transparency.

Canvas is the main reading surface; sidebar is structural. Use `elevated` for a
composer or an actual raised component. Native sheets, menus and popovers retain
their native presentation. Avoid nested cards, tinted page backgrounds, glows,
decorative gradients and arbitrary shadows. `GroupBox` presents a flat section;
`omnesisCard()` is reserved for content that genuinely benefits from a separate
surface. Use native separators for ordinary rows.

## Typography and geometry

Use the system font and the shared typography roles: display 30 semibold,
empty-state title 28 semibold, page title 24 semibold, section 17 semibold,
body 14 regular, secondary 13 regular, navigation and buttons 13 medium,
metadata 12 and caption 11. Reserve monospaced text for codes and other content
whose alignment requires it. Labels must remain readable with long content.

Spacing follows 4, 8, 12, 16, 20, 24 and 32 points. Larger compositional gaps
should be intentional multiples of four. Optical adjustments are allowed;
they should not become new per-screen scales. Radius roles are 4, 6, 8, 12
and 16 points. The native window provides its own rounding.

Use the width appropriate to the task: compact forms up to 520, ordinary forms
640, reading/composer 720 and general content 960 points. Data lists can use
available width. Page margins are normally 24, compact margins 16 and generous
margins 32. Do not apply one maximum width to every screen or scale the whole
interface to fit. Native scrolling, wrapping and window resizing handle space.

The sidebar stays compact and resizable. It uses neutral selection and the
existing modest template brand mark. Keep native `NavigationSplitView` and
`List` selection, keyboard behavior and collapse affordances. Window traffic
lights, dragging, toolbars, full-screen and resizing remain system-owned.

## Components and states

Use native text fields, secure fields, pickers, toggles and menus whenever they
fit. Provide a visible label, relevant help and an actionable error; placeholder
text alone is insufficient. Primary buttons identify the current next action;
secondary buttons are neutral. Destructive actions use an explicit destructive
role and retain their existing confirmation. Icon buttons need a tooltip,
accessibility label and useful hit area.

Mark actual page and section headings with `accessibilityAddTraits(.isHeader)`;
font size alone is insufficient. The shared GroupBox style marks its label,
while content-only groups need an explicit heading on their title. Status and
verification-code text are not automatically headings. Keep native Form and
Section semantics. Outside a native Form, keep a persistent visible label above
inputs, including filled secure fields; placeholders alone are insufficient.

Native form and toolbar controls retain their platform sizing. Use the shared
style for deliberate standalone actions; do not globally restyle native menus
or toolbars.

Ordinary shared buttons have a 30-point minimum height and six points of
vertical padding. Multiline labels grow naturally instead of overflowing a
fixed-height control. Icon-only targets remain 32 points square.

```swift
VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
    Text("Library settings").font(DesktopDesignTokens.Typography.pageTitle)
    Text("Review the computers connected to this library.")
        .foregroundStyle(DesktopTheme.secondary)
    Button("Review devices", action: reviewDevices)
        .buttonStyle(DesktopButtonStyle())
}
.padding(DesktopDesignTokens.Layout.pageMargin)
```

Keep hover, pressed, selected and keyboard focus distinct. Disabled controls
remain readable and do not acquire an active hover appearance. A loading state
keeps stable geometry and truthful progress. Errors and statuses communicate
through text or symbols as well as color. Preserve actual required checks,
retry actions, consent, cancellation and data-removal semantics.

Ask keeps a single composer and conversation identity. The empty introduction
and composer form a close group; an active conversation keeps its composer at
the bottom. Add controls only when an existing capability implements them.
Reference mockups establish composition, not new attachment, filtering or
suggestion features.

Animation is optional, short and purposeful. The shared transition is 180 ms
and returns no animation with Reduce Motion. Avoid decorative repeated motion,
bouncing buttons and unrelated state fades.

## Extending and verifying

Before adding a component, look for the native control or existing shared
primitive. Put a reusable role in the foundation only when actual consumers
need it. Keep screen-specific geometry with that screen; do not introduce a
generic theme framework or dependency for one layout. Add previews for relevant
appearances and states without creating a production component gallery.

Verify ordinary text at 4.5:1, large text at 3:1 and meaningful boundaries/focus
at the applicable non-text contrast. Check disabled readability, keyboard
navigation, VoiceOver labels and order, Increase Contrast, Reduce Motion and
Reduce Transparency. Exercise minimum, typical and wide windows, collapsed and
expanded sidebars, long text and real display scales. Do not substitute a
resized bitmap for a physical backing-scale test.

Use private preferences and synthetic content in tests. Capture and inspect
the actual current light and dark windows and a live System transition.
Preserve capture ownership, foreground, geometry and color-calibration checks.
Component previews and source review do not prove installed application,
permission or assistive-technology behavior. Record measured results and open
gaps in [the verification audit](desktop-design-system-audit.md).
