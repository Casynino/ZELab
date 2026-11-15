/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Dark, futuristic surfaces (Meetly-style).
        background: '#0a0a0b',
        surface: '#151517',
        elevated: '#1e1e22',
        border: '#2a2a30',
        foreground: '#f4f4f5',
        muted: '#a1a1aa',
        faint: '#71717a',
        /* Accent ramp = the house red, from Hao Labs' own mark (Nino, 9 Nov
           2026). Low numbers are dark tints for chips on a near-black page;
           500 is the mark's own red and belongs on fills and the logo; high
           numbers run to coral, which is where accent TEXT lives.

           Why text is not 500: red is a dark hue. The lime this replaced hit
           73% lightness at 400 and carried small text on black easily; the
           same number in red is 45% and fails it. So a fill is brand-500 with
           white on it, and a word is brand-600. The one hex that must be
           exactly right is 500 — change it here and nowhere else. */
        /* Commission and earnings: a soft champagne gold (Nino, 15 Nov 2026 — the violet did not suit the house
           colours). Gold sits with the red and the near-black; it is never the red (money owed), the green
           (money settled) or the amber of a near deadline. Words are earn-300, fills earn-500. */
        earn: {
          200: '#f3dda8',
          300: '#e9c77b',
          400: '#ddb25c',
          500: '#c9973a',
          600: '#a87a26',
        },
        brand: {
          50: '#2a0a06',
          100: '#431009',
          200: '#6a1810',
          300: '#9c2317',
          400: '#d12d1e',
          500: '#ee3124',
          600: '#ff5f4b',
          700: '#ff8d7d',
          800: '#ffb6ab',
          900: '#ffe2dc',
          950: '#fff5f3',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Avenir', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(190,242,100,0.15), 0 8px 30px -8px rgba(132,204,22,0.25)',
      },
    },
  },
  plugins: [],
};
