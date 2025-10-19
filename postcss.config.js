module.exports = (ctx) => ({
  map: false,
  plugins: {
    autoprefixer: {},
    ...(ctx.env === 'production' ? { cssnano: { preset: 'default' } } : {}),
  },
});


