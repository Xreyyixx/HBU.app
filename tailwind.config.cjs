// Сборка статического CSS вместо cdn.tailwindcss.com: npm run build:css
module.exports = {
  content: ['./*.html', './*.js'],
  theme: { extend: {} },
  plugins: []
};
