module.exports = function reactiveMdReactFallback(source) {
  // Radix supplies a fallback, but the published bundle exposes the optional lookup to webpack.
  return source.replace(/\b([A-Za-z_$][\w$]*)\.useEffectEvent\b/g, 'Reflect.get($1, "useEffectEvent")');
};
