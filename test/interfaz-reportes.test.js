'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync('public/index.html', 'utf8');
const renderVentas = html.match(/function renderVentas\(ventas\) \{([\s\S]*?)\n        \}\n\n        function renderTablas/);

assert.ok(renderVentas, 'no se encontró renderVentas');
const cuerpo = renderVentas[1];

// Se ejecuta la función de verdad: si alguien la borra o la cambia de nombre,
// el test falla. Un test que solo busca un texto en el fuente pasa aunque el
// codigo no exista.
function urlDeFotoSegura() {
    const fuente = html.match(/function urlDeFotoSegura\(valor\) \{[\s\S]*?\n        \}/);
    assert.ok(fuente, 'no se encontró urlDeFotoSegura en index.html');
    const contexto = {};
    vm.runInNewContext(`${fuente[0]}\nresultado = urlDeFotoSegura;`, contexto, { filename: 'index.html' });
    return contexto.resultado;
}

test('renderVentas pinta cliente, nota y accesorios', () => {
    assert.match(cuerpo, /cliente/);
    assert.match(cuerpo, /nota/);
    assert.match(cuerpo, /accesorios/);
});

test('la foto se muestra como miniatura de 80 px', () => {
    assert.match(cuerpo, /<img[\s\S]*?80px/);
});

test('la miniatura abre la foto en pestana nueva con seguridad', () => {
    assert.match(cuerpo, /target="_blank"[\s\S]*?rel="noopener"/);
});

test('una venta sin foto ni nota no rompe el render', () => {
    for (const campo of ['cliente', 'nota', 'accesorios']) {
        assert.match(cuerpo, new RegExp(`v\\.${campo}\\s*\\|\\|\\s*''`), `falta proteger ${campo}`);
    }
    // La foto ya no usa `|| ''`: pasa por el validador de URL, que tambien
    // devuelve cadena vacia cuando no hay nada.
    assert.match(cuerpo, /urlDeFotoSegura\(v\.foto\)/);
});

test('urlDeFotoSegura acepta una URL de Drive y rechaza todo lo demas', () => {
    const segura = urlDeFotoSegura();
    const id = '1AbC_dEfGhIjKlMnOpQrStUvWxYz0123456789';

    assert.equal(segura(`https://drive.google.com/uc?export=view&id=${id}`),
        `https://drive.google.com/uc?export=view&id=${id}`);

    // Vacio, ausente o basura: nada que romper el render.
    assert.equal(segura(''), '');
    assert.equal(segura(undefined), '');
    assert.equal(segura(null), '');
    assert.equal(segura('   '), '');

    // Un atacante con acceso de escritura a la hoja podria poner cualquier cosa
    // en la columna Foto. escapeHtml NO escapa comillas (textContent ->
    // innerHTML solo escapa & < >), asi que sin este filtro un valor con comilla
    // doble romperia el atributo href y abriria otra pagina.
    assert.equal(segura('" onerror="alert(1)'), '');
    assert.equal(segura('https://drive.google.com/uc?export=view&id="><script>alert(1)</script>'), '');
    assert.equal(segura('javascript:alert(1)'), '');
    assert.equal(segura('https://malicious.example/foto.jpg'), '');
    assert.equal(segura('//drive.google.com/uc?export=view&id=' + id), '');
    assert.equal(segura('data:text/html,<script>alert(1)</script>'), '');
});

test('la columna Foto de la hoja solo puede producir una URL que se muestre', () => {
    // La URL la arma el Apps Script; si mañana cambia el formato, la foto
    // deja de verse y este test avisa en vez de fallar en silencio.
    const gs = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');
    assert.match(gs, /return\s+"https:\/\/drive\.google\.com\/uc\?export=view&id="\s*\+/);
});
