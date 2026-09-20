/** Marlo Scheduling — Tailwind preset. Import in tailwind.config: presets: [require('./tokens/tailwind.preset')]
 *  Colors reference the CSS variables in marlo.css so light/dark and data-surface switching works without class changes. */
module.exports = {
  theme: {
    extend: {
      colors: {
        marlo: {
          ink: '#191918', slate: '#3e5259', cream: '#f2eade', lime: '#e5feb3', white: '#fcfcfc',
          line: '#ebe3d6', 'line-strong': '#d9d0c2', muted: '#c9c0b2', 'ink-2': '#262624', 'slate-text': '#3e5258', 'cream-2': '#cfc6b8', danger: '#b3261e',
        },
        bg: 'var(--bg)', surface: 'var(--surface)', 'surface-2': 'var(--surface-2)',
        ink: 'var(--ink)', 'ink-muted': 'var(--ink-muted)', line: 'var(--line)', 'line-strong': 'var(--line-strong)',
        accent: 'var(--accent)', 'accent-ink': 'var(--accent-ink)', cta: 'var(--cta)', 'cta-ink': 'var(--cta-ink)', logo: 'var(--logo)',
      },
      fontFamily: { display: ['var(--font-display)'], text: ['var(--font-text)'] },
      fontSize: {
        'display-sm': ['20px', { lineHeight: '1.1', fontWeight: '600' }],
        'display-md': ['30px', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display-lg': ['34px', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display-xl': ['56px', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '700' }],
        'display-hero': ['112px', { lineHeight: '0.95', letterSpacing: '-0.04em', fontWeight: '700' }],
      },
      borderRadius: { sm: '8px', md: '12px', lg: '16px', xl: '20px', '2xl': '28px', pill: '999px' },
      boxShadow: {
        card: '0 1px 0 rgba(25,25,24,0.06), 0 24px 60px -30px rgba(25,25,24,0.25)',
        panel: '0 16px 50px -10px rgba(25,25,24,0.35)',
      },
      height: { control: '48px', 'control-sm': '36px', 'control-xs': '34px', tap: '44px' },
      minHeight: { tap: '44px' },
      transitionTimingFunction: { marlo: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      transitionDuration: { marlo: '160ms' },
    },
  },
};
