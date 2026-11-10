import { StyleSheet } from 'react-native';

const IMAGE_COLORS = Object.freeze({
  primary: '#45D6E2',
  primaryBright: '#8AF0F0',
  primarySoft: 'rgba(69,214,226,0.14)',
  primaryBorder: 'rgba(138,240,240,0.32)',
  primaryBorderSubtle: 'rgba(138,240,240,0.14)',
  secondaryBright: '#C1A9FF',
  dangerText: '#FECACA',
  dangerBorder: 'rgba(237,133,135,0.3)',
});

/** Adapts the original app tokens without importing the separate UI redesign. */
export function createImageStudioTheme(baseTokens = {}) {
  const baseColor = baseTokens.color || {};
  const baseSpace = baseTokens.space || {};
  const baseRadius = baseTokens.radius || {};
  const baseType = baseTokens.type || {};

  return {
    color: {
      background: baseColor.bg || '#090A0E',
      surface: baseColor.surface || '#12141A',
      surfaceRaised: baseColor.surface2 || '#191C24',
      borderSubtle: baseColor.border || 'rgba(235,237,244,0.08)',
      borderStrong: baseColor.borderStrong || 'rgba(235,237,244,0.14)',
      textBright: baseColor.white || '#F8F8FA',
      textMain: baseColor.text || '#E7E8EC',
      textSecondary: baseColor.slate || '#A4A7B0',
      textMuted: baseColor.muted || '#777B85',
      dangerSoft: baseColor.redSoft || 'rgba(237,133,135,0.12)',
      ...IMAGE_COLORS,
    },
    space: {
      xs: baseSpace.xs ?? 8,
      sm: baseSpace.sm ?? 12,
      md: baseSpace.md ?? 16,
      lg: baseSpace.lg ?? 20,
      xl: baseSpace.xl ?? 24,
    },
    radius: {
      sm: baseRadius.sm ?? 10,
      md: baseRadius.md ?? 14,
      lg: baseRadius.lg ?? 18,
      pill: baseRadius.pill ?? 999,
    },
    type: {
      caption: baseType.caption ?? 12,
      captionEmphasis: baseType.caption ?? 12,
      action: 13,
      bodySmall: baseType.body ?? 15,
      bodyEmphasis: baseType.subtitle ?? 16,
      title: baseType.title ?? 20,
      weightStrong: '700',
      weightSemibold: '600',
      weightBold: '700',
      leading: {
        compact: baseType.caption ? baseType.caption + 5 : 17,
        body: baseType.bodyLine ?? 24,
      },
    },
  };
}

export function createImageStudioStyles(tokens) {
  const C = tokens.color;
  const SPACE = tokens.space;
  const RADIUS = tokens.radius;
  const TYPE = tokens.type;

  return StyleSheet.create({
    imageStudioRoot: { flex: 1, backgroundColor: C.background },
    imageStudioHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.md, borderBottomWidth: 1, borderBottomColor: C.borderSubtle },
    imageStudioEyebrow: { color: C.primaryBright, fontSize: TYPE.caption, fontWeight: TYPE.weightStrong, letterSpacing: 1.8 },
    imageStudioTitle: { color: C.textBright, fontSize: TYPE.title, fontWeight: TYPE.weightBold, letterSpacing: -0.4, marginTop: 2 },
    imageStudioScroll: { flex: 1 },
    imageStudioContent: { paddingHorizontal: SPACE.md, paddingTop: SPACE.md, paddingBottom: SPACE.xl, gap: SPACE.sm },
    imageStudioDescription: { color: C.textSecondary, fontSize: TYPE.bodySmall, lineHeight: TYPE.leading.body, marginBottom: SPACE.xs },
    imageStudioPrompt: { minHeight: 116, maxHeight: 180, padding: SPACE.md, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderStrong, color: C.textMain, fontSize: TYPE.bodySmall, lineHeight: TYPE.leading.body },
    imageStudioPromptMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: SPACE.xs },
    imageStudioFieldLabel: { color: C.textMuted, fontSize: TYPE.caption, fontWeight: TYPE.weightStrong, letterSpacing: 1.1 },
    imageStudioCounter: { color: C.textMuted, fontSize: TYPE.caption, fontVariant: ['tabular-nums'] },
    imageStudioRatioRow: { flexDirection: 'row', gap: SPACE.xs, marginBottom: SPACE.xs },
    imageStudioRatio: { flex: 1, minWidth: 52, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderSubtle },
    imageStudioRatioSelected: { backgroundColor: C.primarySoft, borderColor: C.primaryBorder },
    imageStudioRatioText: { color: C.textSecondary, fontSize: TYPE.captionEmphasis, fontWeight: TYPE.weightSemibold },
    imageStudioRatioTextSelected: { color: C.primaryBright },
    imageStudioPreview: { minHeight: 208, maxHeight: 380, aspectRatio: 1, width: '100%', alignSelf: 'center', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.lg, backgroundColor: C.surface, borderWidth: 1, borderColor: C.borderStrong },
    imageStudioPreviewImage: { width: '100%', height: '100%' },
    imageStudioProgress: { alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
    imageStudioProgressTitle: { color: C.textBright, fontSize: TYPE.bodyEmphasis, fontWeight: TYPE.weightSemibold, marginTop: SPACE.md },
    imageStudioProgressCopy: { color: C.textSecondary, fontSize: TYPE.captionEmphasis, marginTop: SPACE.xs },
    imageStudioEmpty: { alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
    imageStudioEmptyMark: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.pill, backgroundColor: C.primarySoft, borderWidth: 1, borderColor: C.primaryBorderSubtle },
    imageStudioEmptyTitle: { color: C.textBright, fontSize: TYPE.bodyEmphasis, fontWeight: TYPE.weightSemibold, marginTop: SPACE.sm },
    imageStudioEmptyCopy: { color: C.textMuted, fontSize: TYPE.captionEmphasis, lineHeight: TYPE.leading.compact, textAlign: 'center', marginTop: SPACE.xs },
    imageStudioNotice: { color: C.primaryBright, fontSize: TYPE.captionEmphasis, lineHeight: TYPE.leading.compact },
    imageStudioNoticeError: { color: C.dangerText },
    imageStudioActions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    imageStudioPrimary: { minHeight: 48, flexGrow: 1, flexBasis: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.primaryBright, borderWidth: 1, borderColor: C.primaryBorder },
    imageStudioPrimaryText: { color: C.background, fontSize: TYPE.action, fontWeight: TYPE.weightBold },
    imageStudioSecondary: { minHeight: 48, minWidth: 64, flexGrow: 0.55, flexBasis: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: SPACE.xs, borderRadius: RADIUS.md, backgroundColor: C.surfaceRaised, borderWidth: 1, borderColor: C.borderStrong },
    imageStudioSecondaryText: { color: C.textMain, fontSize: TYPE.captionEmphasis, fontWeight: TYPE.weightSemibold },
    imageStudioSecondaryWide: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.md, backgroundColor: C.surfaceRaised, borderWidth: 1, borderColor: C.borderStrong },
    imageStudioCancel: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, borderRadius: RADIUS.md, backgroundColor: C.dangerSoft, borderWidth: 1, borderColor: C.dangerBorder },
    imageStudioCancelText: { color: C.dangerText, fontSize: TYPE.action, fontWeight: TYPE.weightSemibold },
    imageStudioPrivacy: { color: C.textMuted, fontSize: TYPE.caption, lineHeight: TYPE.leading.compact, textAlign: 'center', marginTop: SPACE.xs },
  });
}
