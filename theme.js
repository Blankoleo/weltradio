// Wird im <head> vor dem ersten Zeichnen geladen: Farbschema setzen (kein Aufblitzen).
(function () {
  var t; try { t = JSON.parse(localStorage.getItem('wr.theme')); } catch (e) {}
  if (['nacht', 'sand', 'salbei', 'himmel', 'rose'].indexOf(t) < 0) t = 'nacht';
  document.documentElement.dataset.theme = t;
  var m; try { m = JSON.parse(localStorage.getItem('wr.calm')); } catch (e) {}
  if (m === true) document.documentElement.classList.add('calm');
  // Helle Schemata: dunkle Schrift in der Statusleiste (wirkt nach einem Neustart der App)
  if (t !== 'nacht') document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content = 'default';
})();
