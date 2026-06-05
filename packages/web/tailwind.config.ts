import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: {
          950: "#101114",
          900: "#17191d",
          850: "#1d2026",
          800: "#242831",
          700: "#303644",
          600: "#454d5f",
        },
        accent: {
          500: "#5ea9ff",
          600: "#3e8ee6",
        },
        mint: {
          500: "#64d7a7",
        },
        amberSoft: {
          500: "#f2b66d",
        },
      },
      boxShadow: {
        panel: "0 18px 60px rgba(0, 0, 0, 0.28)",
      },
    },
  },
  plugins: [],
} satisfies Config;
