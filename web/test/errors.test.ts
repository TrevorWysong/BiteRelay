import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../src/lib/ui/errors";
import { useLocale } from "../src/i18n";
import { en } from "../src/i18n/en";
import { es } from "../src/i18n/es";

/// A zome call's failure, as the client reports it.
const refused = (message: string) => new Error(`Wasm runtime error while working with Ribosome: RuntimeError: dispatch::bids:41: Guest("${message.replace(/"/g, '\\"')}")`);

function inSpanish(run: () => void) {
  useLocale.setState({ locale: "es", catalog: es });
  try {
    run();
  } finally {
    useLocale.setState({ locale: "en", catalog: en });
  }
}

test("a refusal reads as its sentence, in English as written", () => {
  assert.equal(describeError(refused("This order isn't taking offers any more.")), "This order isn't taking offers any more.");
});

test("in Spanish, a refusal is translated, its values filled back in", () => {
  inSpanish(() => {
    assert.equal(describeError(refused("This order isn't taking offers any more.")), "Este pedido ya no acepta ofertas.");
    assert.equal(describeError(refused("That code isn't right. 2 tries left.")), "Ese código no es correcto. Te quedan 2 intentos.");
    // An amount comes back in the network's currency, not as minor units.
    assert.match(describeError(refused("You can cash out 2500 or more at once.")), /^Puedes retirar \D*25[.,]00\D* o más de una vez\.$/);
  });
});

test("the issuer's and the runtime's refusals are translated too, not only the zomes'", () => {
  inSpanish(() => {
    assert.equal(describeError(new Error("Too many requests from here. Try again later.")), "Demasiadas solicitudes desde aquí. Inténtalo más tarde.");
    assert.equal(describeError(new Error("That isn't a code from HandShake's move to a new phone.")), "Ese no es un código del traslado de HandShake a un teléfono nuevo.");
  });
});

test("a zome's diagnostic says something went wrong, with the detail kept", () => {
  assert.equal(describeError(refused("could not read back bid")), "Something went wrong (could not read back bid). Try again.");
  inSpanish(() => assert.equal(describeError(refused("could not read back bid")), "Algo salió mal (could not read back bid). Inténtalo de nuevo."));
});

test("anything else is left as it is", () => {
  assert.equal(describeError(new Error("The connection to your node dropped mid-request.")), "The connection to your node dropped mid-request.");
});
