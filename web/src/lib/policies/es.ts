// Las políticas en español: las mismas reglas que en.ts, sección por sección
// y punto por punto (test/policies.test.ts lo comprueba).
import { HANDOFF_CODE_DIGITS, type NetworkTerms } from "../../holochain/types";
import { formatCents } from "../format";
import { spoken, type PolicyChange, type PolicyContent, type PolicySection } from "./common";

const changes: PolicyChange[] = [
  {
    version: "1.3",
    date: "2026-10-19",
    summary:
      "Si una red nombra árbitros, el cliente puede apelar una vez la liquidación de una tienda, y lo que conceda el árbitro se paga con los retiros de la tienda. Las redes pueden exigir que los repartidores estén verificados y pueden permitir artículos con restricción de edad, que se recogen en persona mostrando la identificación. Las cuentas pasan a las nuevas versiones de la red con su saldo y su historial.",
  },
  {
    version: "1.2",
    date: "2026-10-10",
    summary:
      "Las tiendas cocinan cuando un repartidor se compromete. Los repartidores hacen check-in en el mostrador y la tienda entrega el pedido escaneando el código del repartidor. Al cliente nunca se le cobra comida que no recibió salvo que él lo eligiera: el repartidor que deja un pedido ya en preparación lo paga si ningún otro lo coge, y la tienda que hace esperar a un repartidor más de lo que ella misma fijó le paga su tarifa, el pedido pasa a otro repartidor y el cliente puede cancelar con reembolso completo. El cliente puede recoger él mismo un pedido que se retrasa y recuperar la parte del envío que pagaba la tienda. Las apps pueden asignar repartidores automáticamente según una regla pública, y los repartidores pueden pujar automáticamente.",
  },
  {
    version: "1.1",
    date: "2026-10-09",
    summary:
      "Sin árbitros. Las entregas se demuestran con el código de quien entrega o con su propia confirmación, tanto al recoger como en la puerta. Dejar un pedido en la puerta es elección y riesgo del cliente. La tienda decide sobre una entrega que no llegó (cobra en cualquier caso, del cliente o de la garantía del repartidor) y tiene la última palabra sobre los artículos que faltan. Los repartidores llevan un número limitado de pedidos a la vez, y un pedido prioritario va solo. Límites a los pedidos en espera, una oferta por repartidor, reservas de bolsas sorpresa, mínimos de las tiendas y momentos de mucha demanda.",
  },
  {
    version: "1.0",
    date: "2026-10-09",
    summary: "Primera publicación: pagos retenidos en depósito, PIN de entrega y escaneos, plazo para informar de artículos que faltan, disputas, reputación, privacidad y riesgos.",
  },
];

function sections(t: NetworkTerms): PolicySection[] {
  const reportWindow = spoken(t.report_window_secs);
  return [
    {
      id: "payments",
      title: "Pagos y depósito",
      summary: "El dinero se reserva en cada paso y solo se mueve con una prueba o con la decisión de la tienda sobre el pedido. Relay no cobra comisión.",
      points: [
        "Cuando una tienda acepta tu pedido, el precio de la comida se reserva de tu saldo. Cuando aceptas la oferta de un repartidor, también se reservan su tarifa y tu propina.",
        "El repartidor reserva el valor de la comida al comprometerse con el pedido, antes de que la tienda empiece a cocinar. Esa es su garantía: vuelve a ser suya cuando el pedido se entrega.",
        "Cuando la tienda hace el check-in del repartidor en su mostrador, reserva su parte de la tarifa, y otra vez tu parte por si le hace esperar.",
        "Cada parte de un pago se decide una sola vez. Nadie puede cobrarla dos veces ni recuperar lo que ya se pagó.",
        "Tu saldo es la suma de tu propio registro firmado. Cada movimiento aparece en la página de Transparencia.",
        t.credit_limit_cents > 0
          ? `Esta red permite que un saldo baje hasta ${formatCents(t.credit_limit_cents)} por debajo de cero.`
          : "En esta red un saldo no puede bajar de cero: solo puedes gastar lo que has ingresado.",
        "No hay comisión de plataforma ni cuenta de operador. Tiendas, repartidores y clientes se pagan directamente entre sí.",
      ],
    },
    {
      id: "cash-out",
      title: "Añadir fondos y retirar",
      summary: "El dinero entra y sale a través de los emisores de esta red. La red en sí nunca guarda el dinero de nadie.",
      points: [
        "Añades fondos pagando con tarjeta a uno de los emisores de la red, que suma exactamente ese importe a tu saldo: añadir fondos es gratis. Tu saldo funciona como una tarjeta regalo para toda la red.",
        "Cada tienda fija su propio impuesto sobre ventas o IVA, como vendedora. El pago y tu recibo lo muestran: añadido al precio o ya incluido.",
        "Lo que puedes añadir con tarjeta crece con tu cuenta: una cuenta nueva puede añadir un poco al día, y más a medida que pide. El primer pago con una tarjeta puede pedir a tu banco que confirme que eres tú.",
        "Si a tu saldo le falta dinero al pagar, pagas la diferencia con tarjeta en ese momento, y tu pedido se hace en cuanto se paga. La tarjeta se guarda en el emisor, nunca en Relay, así que la próxima vez es un toque; también puedes recargar el saldo automáticamente cuando baje.",
        `Para retirar, pides a un emisor que te pague parte de tu saldo fuera de la red. Puedes retirar ${formatCents(t.min_redemption_cents)} o más, hasta lo que haya en tu saldo; el dinero reservado para pedidos y el crédito nunca se pueden retirar.`,
        "Cada emisor publica su comisión de retiro, que cubre sus costes de tarjeta y transferencia, y cuánto tardan los pagos; la app te muestra lo que recibirás antes de confirmar.",
        "Configuras tu cuenta de cobro en el procesador de tu emisor una sola vez, demostrando con tu propia clave que es tuya. Tus datos bancarios nunca pasan por Relay. Un retiro vuelve primero a las tarjetas con las que pagaste, y solo lo que quede después, lo que ganaste, va a tu banco. El primer pago bancario de una cuenta nueva espera alrededor de una semana.",
        "Si disputas un pago con tarjeta ante tu banco, el emisor pausa los ingresos y los retiros de tu cuenta hasta que se resuelva la disputa.",
        "Tu emisor registra una sola vez qué hizo con cada retiro: pagado, con su referencia de pago, o rechazado. Un retiro rechazado vuelve a tu saldo automáticamente.",
        "Los datos de cobro que añades se sellan para que solo ese emisor pueda leerlos.",
      ],
    },
    {
      id: "handoffs",
      title: "Entregar un pedido",
      summary: "Cada entrega la demuestra quien entrega el pedido: la tienda en su mostrador y el cliente en la puerta.",
      points: [
        `En la tienda, el repartidor hace el check-in escaneando el código de ${HANDOFF_CODE_DIGITS} dígitos de la tienda, o tecleándolo, y la app de la tienda lo comprueba. El check-in demuestra que está allí; no entrega nada.`,
        "La tienda entrega el pedido escaneando el código del repartidor o confirmándolo en su app. Solo el registro de entrega de la tienda permite al repartidor recogerlo.",
        `En la puerta, el cliente tiene su propio código. El repartidor lo escanea, teclea los dígitos que le dicen, o el cliente lo confirma en su app. Tras ${t.max_code_attempts} códigos incorrectos, teclear deja de funcionar para ese pedido.`,
        "Un repartidor no puede recoger un pedido sin el registro de la tienda, ni completar una entrega sin la prueba del cliente.",
        "Comparte tu código solo cuando tengas el pedido en las manos: demuestra que lo recibiste y no se puede deshacer.",
        "Si eliges que dejen tu pedido en la puerta, aceptas que se considera entregado cuando el repartidor lo deja allí. Hará una foto del lugar; si alguien se lo lleva después, no se reembolsa.",
        "Las tiendas pueden fijar un importe a partir del cual siempre entregan en mano.",
      ],
      effects: [
        { who: "customers", good: "Nadie puede marcar tu pedido como entregado sin tu código o tu confirmación, salvo que elegiste dejarlo en la puerta.", bad: "Dar tu código antes de revisar tu pedido significa aceptarlo como entregado." },
        { who: "drivers", good: "Una entrega completada con el código o la confirmación del cliente es definitiva: nadie puede decir después que no llegó.", bad: "Sin la prueba del cliente no puedes completar una entrega en mano, y solo cobras cuando se completa." },
        { who: "stores", good: "Una vez escaneado el código del repartidor, la comida queda a su cargo, cubierta por su garantía.", bad: "Escanéalo solo al entregar la comida: tu registro es la prueba de que la tiene." },
      ],
    },
    {
      id: "items",
      title: "Artículos que faltan o incorrectos",
      summary: `Tienes ${reportWindow} desde que recibes tu pedido para informar de un problema con tus artículos. La tienda revisa cada informe y tiene la última palabra.`,
      points: [
        "Elige los artículos y cantidades que faltaban o eran incorrectos, y añade una nota o foto si quieres. El reembolso de cada artículo es su parte de lo que realmente pagaste, después de cualquier promoción.",
        t.appeals
          ? `La tienda acepta o rechaza cada informe. Si no estás de acuerdo con cómo lo liquidó, puedes apelar una vez, en un plazo de ${spoken(t.appeal_window_secs)}, ante uno de los árbitros de la red: el propio pedido decide cuál, ambas partes dan sus pruebas solo al árbitro, y el árbitro puede conceder hasta lo que la tienda se quedó. Lo concedido se te paga con los próximos retiros de la tienda.`
          : "La tienda acepta o rechaza cada informe, y su respuesta es definitiva, como lo sería si le hubieras pedido directamente.",
        `El pago a la tienda por la comida espera hasta que se cierra tu plazo. Los informes que acepta, o que nunca responde, se reembolsan entonces; por tarde que informes, la tienda tiene al menos ${spoken(t.answer_grace_secs)} para responder.`,
        "El pago a tu repartidor no espera a este plazo: lo que hay dentro de una bolsa cerrada no es responsabilidad suya.",
        "Tu nota y tu foto se sellan para la tienda. Nadie más puede leerlas.",
      ],
      effects: [
        t.appeals
          ? { who: "customers", good: "La tienda que ignora tu informe lo reembolsa, y un árbitro puede corregir a la que lo rechaza injustamente.", bad: "Solo puedes apelar un pedido una vez, y la decisión del árbitro es definitiva." }
          : { who: "customers", good: "La tienda que ignora tu informe lo reembolsa.", bad: "Una tienda puede rechazar un informe. Tu reseña es cómo los demás se enteran si lo hace injustamente." },
        t.appeals
          ? { who: "stores", good: "Tú decides primero cada reembolso, y das tu versión al árbitro en cualquier apelación.", bad: "Lo que conceda un árbitro se descuenta de tu próximo retiro." }
          : { who: "stores", good: "Tú decides cada reembolso. Nadie puede concederlo por encima de tu respuesta.", bad: "Cobras la comida cuando se cierra el plazo de informes, no en la puerta, y los informes que no respondes se reembolsan." },
      ],
    },
    {
      id: "never-arrived",
      title: "Si un pedido no llega",
      summary: "El repartidor responde de la comida desde que la recoge hasta que el cliente la tiene.",
      points: [
        "Desde que tu repartidor recoge tu pedido, y hasta que se entrega, puedes decir que no llegó. Tu repartidor aún puede aparecer y entregarlo como siempre.",
        `Si no lo hace, decide la tienda. Su app lo hace sola cuando tu reclamación lleva ${spoken(t.claim_grace_secs)}, o la tienda puede decidir antes.`,
        "Cuando la tienda decide que no llegó, recuperas lo que pagaste por la comida, el envío y tu propina. La tienda recupera su parte de la tarifa, y la garantía del repartidor paga a la tienda la comida.",
        "La tienda cobra la comida en cualquier caso, de ti si llegó o del repartidor si no, así que no gana nada con ninguna respuesta.",
        "Una entrega completada con tu código, tu confirmación, o dejada en tu puerta como elegiste, no se puede reclamar después.",
      ],
      effects: [
        { who: "customers", good: "Nunca pierdes dinero por comida que no te llegó.", bad: "Si dices que no llegó y luego se entrega, queda en tu historial, donde lo ven los repartidores." },
        { who: "drivers", good: "Si lo entregas con el código del cliente, nadie puede decir que no llegó.", bad: "Si lo recoges y no lo entregas, pierdes tu garantía y tu tarifa, y queda en tu historial." },
        { who: "stores", good: "La comida siempre se paga.", bad: "Tú decides qué pasa cuando cliente y repartidor no están de acuerdo, y esa decisión es pública." },
      ],
    },
    {
      id: "drivers",
      title: "Cuántos pedidos lleva un repartidor",
      summary:
        t.max_concurrent_deliveries === 1
          ? "Un repartidor lleva como máximo 1 pedido a la vez, como en las grandes apps de reparto, y puedes pedir uno sin otros pedidos."
          : `Un repartidor lleva como máximo ${t.max_concurrent_deliveries} pedidos a la vez, como en las grandes apps de reparto, y puedes pedir uno sin otros pedidos.`,
      points: [
        `Un repartidor puede aceptar como máximo ${t.max_concurrent_deliveries} ${t.max_concurrent_deliveries === 1 ? "pedido" : "pedidos"} a la vez. La red cuenta los compromisos que ha asumido y rechaza uno más allá de eso, así que ninguna app puede saltárselo.`,
        `Mientras reparte, a un repartidor solo se le ofrecen pedidos de camino: de una tienda donde aún tiene que recoger, o que van a menos de ${t.add_on_detour_km} km de una de sus entregas.`,
        "Cada oferta muestra cuántos pedidos más tiene ese repartidor, y tú eliges. Un repartidor no puede ocultar los pedidos que ha aceptado.",
        "Elige Prioritario al pagar para un repartidor sin otros pedidos. Nadie puede recoger tu pedido llevando otro, ni otro llevando el tuyo. Los repartidores suelen pujar más por ello.",
        "Un repartidor cuyo pedido no llega puede aceptar más en cuanto pierde su garantía por él, cosa que su app hace al decidir la tienda.",
        ...(t.drivers_verified
          ? [`Los repartidores de esta red se verifican antes de poder pujar: uno de sus verificadores comprueba su identidad, permiso de conducir y seguro, por un máximo de ${t.verification_days} días cada vez. Un verificador puede retirar una verificación, y las apps de los clientes dejan de aceptar a ese repartidor al instante.`]
          : []),
      ],
      effects: [
        { who: "customers", good: "Tu pedido no es uno de muchos en una ruta larga, y Prioritario garantiza que es el único.", bad: "Un pedido prioritario puede tardar más en encontrar repartidor, y suele costar más." },
        { who: "drivers", good: "Los pedidos de camino te hacen ganar más por el mismo trayecto.", bad: "Pasado el límite, o con un pedido prioritario, no se te ofrece nada más hasta que entregues." },
      ],
    },
    {
      id: "matching",
      title: "Cómo se elige un repartidor",
      summary: "Como en las grandes apps de reparto, tu app puede elegir un repartidor por ti, con una regla que cualquiera puede comprobar. O eliges tú.",
      points: [
        `Los repartidores pujan por tu pedido con su tarifa y cuándo te lo llevarían. ${spoken(t.bid_window_secs)} después de la primera oferta, tu app acepta la mejor.`,
        `La mejor oferta es la de tarifa más baja contando cada minuto hasta la entrega como ${formatCents(t.minute_value_cents)} y teniendo en cuenta los pedidos abandonados del repartidor: un repartidor más rápido puede ganar con una tarifa más alta, y uno que abandona pedidos tiene que pujar más bajo para ganar.`,
        "No se eligen las ofertas que superan tu tarifa máxima, las de un repartidor que ya dejó tu pedido, ni las de uno que ahora no puede aceptar otro. Las ofertas que un repartidor deja caducar cuentan en su contra como pedidos abandonados.",
        "Un repartidor ve tu dirección exacta solo cuando se ha comprometido con tu pedido y ha reservado su garantía.",
        "Elige «Elijo yo» al pagar para ver todas las ofertas y aceptar una tú.",
        `Una vez elegido, el repartidor tiene ${spoken(t.offer_secs)} para comprometerse, como en DoorDash. Los repartidores pueden dejar que su app puje por ellos a su propia tarifa, evitando tiendas de las que otros repartidores informan.`,
      ],
      effects: [
        { who: "customers", good: "Se encuentra repartidor sin que tengas que mirar la pantalla, con una regla igual para todos.", bad: "La oferta más barata no siempre gana: también cuentan el tiempo y la fiabilidad." },
        { who: "drivers", good: "Los repartidores fiables y rápidos ganan más a menudo, incluso con tarifas más altas.", bad: "Abandonar pedidos te cuesta ofertas." },
      ],
    },
    {
      id: "late",
      title: "Cuando un repartidor o una tienda se retrasan",
      summary: "Nunca se te cobra comida que no recibiste salvo que lo elijas. Quien causa el retraso lo paga, en la medida en que la red puede verlo.",
      points: [
        "La tienda empieza a cocinar solo cuando un repartidor se ha comprometido, así que un pedido que ningún repartidor acepta no le cuesta nada a nadie: cancélalo y se te reembolsa todo.",
        `Si un repartidor no está en la tienda en un plazo de ${spoken(t.pickup_grace_secs)} desde cuando debía llegar, la app de la tienda lo aparta y tu pedido pasa a otro repartidor.`,
        `Un repartidor puede dejar un pedido antes de recogerlo. Si la tienda ya había empezado a cocinarlo, responde de la comida: si ningún otro repartidor lo acepta en ${spoken(t.replacement_window_secs)}, el pedido termina, se te reembolsa todo y su garantía paga a la tienda.`,
        `Cada tienda fija cuánto puede hacer esperar a un repartidor con check-in después de su hora de listo (de ${spoken(t.min_store_wait_secs)} a ${spoken(t.max_store_wait_secs)}; ${spoken(t.store_wait_secs)} si no lo fija), y lo ves al pagar. Pasado ese tiempo, el repartidor puede declarar que la tienda se retrasa e irse: la tienda le paga toda su tarifa, tu pedido pasa a otro repartidor y puedes cancelar con reembolso completo.`,
        "Si tu repartidor se retrasa, o nadie tiene tu pedido, puedes recogerlo tú en la tienda. La comida cuesta lo mismo, te devuelven la parte del envío que pagaba la tienda, y también lo que reservaste para un repartidor.",
        `Si eliges recogerlo y no vienes en ${spoken(t.collection_window_secs)}, la tienda se queda con el precio de la comida que preparó. Si cancelas mientras un repartidor está de camino y nadie se ha retrasado, pagas la comida y la tarifa del repartidor, como en cualquier app.`,
        "Cada plazo que perjudica a otro si se reclama antes de tiempo (un repartidor que se va, una tienda que aparta a un repartidor, declarar que una tienda se retrasa, terminar un pedido al que no vino ningún repartidor, quedarse la comida de un cliente que no vino) se demuestra con una fuente pública de tiempo gestionada por organizaciones independientes, así que nadie puede reclamarlo antes.",
        `Un pedido puede cambiar de repartidor como máximo ${t.max_driver_changes} veces. Después puedes recogerlo o cancelarlo.`,
        "Mientras un repartidor que dejó tu pedido ya en preparación responde de él, no puedes cancelarlo: espera a otro repartidor (se te reembolsa todo si no llega ninguno a tiempo) o recógelo tú.",
      ],
      effects: [
        { who: "customers", good: "Que no haya repartidor, que no aparezca, o que la tienda sea lenta nunca te cuesta nada.", bad: "Si eliges recogerlo y no lo haces, o cancelas cuando ya va de camino, pagas la comida." },
        { who: "drivers", good: "Con check-in hecho, cobras todo si la tienda te hace esperar, y nunca cuenta en tu contra.", bad: "Dejar un pedido que la tienda ha cocinado puede costarte su precio, si nadie más lo acepta." },
        { who: "stores", good: "Solo cocinas para un repartidor comprometido, tú fijas cuánto espera, y cobras la comida que un repartidor deja.", bad: "Si haces esperar a un repartidor con check-in más de lo que fijaste, pagas su tarifa, y el cliente puede cancelar con reembolso completo." },
      ],
    },
    {
      id: "fair-use",
      title: "Uso justo",
      summary: "Límites que impiden que una persona acapare a los demás, aplicados por la red.",
      points: [
        t.max_pending_orders === 1
          ? `Un cliente puede tener como máximo 1 pedido hecho en ${spoken(t.store_response_secs)}, el tiempo que tiene una tienda para responder. Un pedido no cuesta nada hasta que una tienda lo acepta, así que esto impide sepultar a una tienda en pedidos.`
          : `Un cliente puede tener como máximo ${t.max_pending_orders} pedidos hechos en ${spoken(t.store_response_secs)}, el tiempo que tiene una tienda para responder. Un pedido no cuesta nada hasta que una tienda lo acepta, así que esto impide sepultar a una tienda en pedidos.`,
        "Un repartidor puja por un pedido una sola vez. Su oferta es su oferta, así que nadie puede llenar las ofertas de un pedido con las suyas.",
        "Cuando una tienda confirma tu bolsa sorpresa, te la guarda el tiempo que fijó la tienda. Si no la has pedido para entonces, vuelve a la venta. Tu app la pide en cuanto se confirma.",
        "Una tienda puede fijar un pedido mínimo e indicar que tiene mucha demanda, sumando tiempo a su preparación habitual. Ves ambas cosas antes de pedir.",
        `Publicar una tienda reserva un depósito de ${formatCents(t.store_listing_stake)}, que se devuelve al cerrarla, así que toda tienda que encuentras es real.`,
        "Reclamas una bolsa sorpresa una vez, reseñas a la tienda y al repartidor de un pedido una vez cada uno, e informas de cada artículo de un pedido una vez.",
        t.restricted_min_age
          ? `Los artículos con restricción de edad, como el alcohol, solo se venden a personas de ${t.restricted_min_age} años o más, y se recogen en persona: confirmas tu edad al pedir y la tienda comprueba tu identificación en el mostrador. Nunca se envían.`
          : "Esta red no vende artículos con restricción de edad, como el alcohol.",
      ],
    },
    {
      id: "cancellations",
      title: "Cancelaciones",
      summary: "Lo que cuesta cancelar depende de lo avanzado que estuviera el pedido.",
      points: [
        "Antes de que una tienda acepte tu pedido, cancelar no cuesta nada.",
        "Después de que la tienda lo acepte, cancelar significa que la tienda se queda con el precio de la comida que empezó. Después de asignar un repartidor, el repartidor se queda también con su tarifa. Tu propina siempre se te devuelve.",
        "Si cancela una tienda o un repartidor, se te devuelve todo lo que se les habría pagado.",
        "Una vez que el repartidor ha recogido tu pedido, no se puede cancelar: o se entrega, o no llega (ver más arriba).",
      ],
    },
    {
      id: "who-decides",
      title: "Quién decide",
      summary: t.appeals
        ? "No hay empresa ni operador. Las pruebas resuelven casi todo; donde no pueden, decide la tienda, y el cliente puede apelar su liquidación ante uno de los árbitros de la red."
        : "No hay empresa, operador ni árbitro. Las pruebas resuelven casi todo; donde no pueden, decide la tienda, dentro de unas reglas que aplica la app de todos.",
      points: [
        "Un código de entrega, una confirmación o una cancelación resuelven un pedido por sí solos.",
        "Para cada pedido, la tienda escribe un resultado y una liquidación de la comida, y la red no acepta un segundo de ninguno. Todos los pagos se basan en ellos, así que ningún pago puede contradecir a otro.",
        "La tienda no puede quedarse a la vez con el dinero del cliente y con la garantía del repartidor, ni reembolsar más de lo que valen los informes que cita, ni decidir que no se entregó un pedido que ella canceló.",
        "Cada decisión está firmada y es pública, y queda registrada contra quien salió perjudicado.",
        ...(t.appeals ? ["Un árbitro resuelve una apelación una sola vez y no concede más de lo pedido. El emisor de la red, que guarda el dinero que respalda cada saldo, paga lo concedido con los retiros de la tienda."] : []),
      ],
    },
    {
      id: "reputation",
      title: "La reputación con el tiempo",
      summary: "Tu historial te acompaña, y se construye solo con cosas que pasaron de verdad.",
      points: [
        "Las valoraciones son un voto por cliente y pedido, y solo del cliente de ese pedido.",
        "Los pedidos completados se registran para la tienda y el repartidor. La decisión de una tienda de que un pedido no llegó se registra contra el repartidor; la de que un pedido reclamado sí llegó, contra el cliente.",
        "Nadie puede editar ni borrar reseñas, valoraciones ni historial, tampoco los suyos.",
        `Las valoraciones y el historial cuentan los últimos ${t.reputation_window_days} días, para que digan cómo le va a alguien ahora. El historial anterior sigue en la red.`,
        "Los repartidores ven el historial de un cliente antes de pujar.",
      ],
      effects: [
        { who: "customers", good: "Un historial limpio hace que los repartidores acepten tus pedidos con gusto.", bad: "Decir que un pedido no llegó cuando sí llegó queda en tu historial." },
        { who: "stores", good: "Los pedidos completados y las buenas valoraciones construyen la nota que ven los clientes.", bad: "Las valoraciones no se pueden quitar, ni siquiera las injustas." },
        { who: "drivers", good: "Las entregas completadas construyen el historial que ven los clientes al elegir una oferta.", bad: "Los pedidos que no llegaron se quedan en tu historial." },
      ],
    },
    {
      id: "account",
      title: "Tu cuenta y cómo recuperarla",
      summary: "Tu cuenta es una clave en tu dispositivo. No hay empresa que pueda restablecerla, así que estas son las formas de volver a entrar.",
      points: [
        "Cambiar de teléfono: el teléfono antiguo traspasa la cuenta al nuevo, con tu saldo, valoraciones e historial. El antiguo ya no puede gastar después.",
        "Perder el teléfono: tu frase de recuperación (doce palabras que apuntas) o suficientes de tus guardianes (personas que eliges y que avalan tu nuevo teléfono) te devuelven la cuenta.",
        "Tras una recuperación, el emisor de la red vuelve a emitir tu saldo en tu nuevo teléfono, cuando tu teléfono antiguo lleva sin usarse el periodo de espera del emisor. Así nadie con tu teléfono antiguo puede gastar el mismo dinero dos veces.",
        "Cualquiera con tu frase de recuperación puede quedarse con tu cuenta. Guárdala en papel, no la compartas nunca, y nadie de Relay te la pedirá jamás.",
        "Los guardianes no pueden tocar tu cuenta por su cuenta: solo suficientes de ellos juntos, para un teléfono en el que estás recuperándola. Tu plan publica sus claves, nunca sus nombres.",
        "Cuando la red pasa a una nueva versión, mueves tu cuenta a ella desde la app antigua: el emisor traslada tu saldo, y tus datos, tiendas y valoraciones vienen contigo. La versión antigua deja de funcionar para tu cuenta una vez te mueves.",
      ],
    },
    {
      id: "privacy",
      title: "Privacidad",
      summary: "Se te conoce por una clave, no por un nombre. Lo privado está sellado; lo que no, se dice aquí.",
      points: [
        "Los clientes no publican ningún nombre. Tu nombre y tu dirección exacta se sellan para la tienda y para el repartidor que aceptas, solo para ese pedido.",
        "Las fotos y ubicaciones de las entregas se sellan entre las dos personas de la entrega.",
        "Los repartidores no publican su ubicación. Encuentran trabajo leyendo los pedidos abiertos a su alrededor.",
        "Visible para cualquiera: qué clave de cliente pidió a qué tienda, los precios de un pedido y su zona de entrega con una precisión de aproximadamente un kilómetro.",
      ],
    },
  ];
}

/// Lo que podría salir mal, claramente.
function risks(t: NetworkTerms): string[] {
  return [
    "Relay es software que gestionan sus usuarios, no una empresa que respalde tus pedidos. Nadie puede revertir un pago que la red ha liquidado, y no hay servicio de atención al cliente.",
    "Cuando cliente y repartidor no están de acuerdo sobre una entrega, decide la tienda. Una tienda podría ponerse del lado de un cliente contra un repartidor que sí entregó; no gana nada con ello y su decisión es pública, pero la red no puede anularla. Los repartidores se protegen entregando con el código del cliente.",
    "Un pedido dejado en la puerta se considera entregado al dejarlo. Si alguien se lo lleva después, la pérdida es del cliente, como un paquete dejado sin firma.",
    "Nada obliga a una tienda a responder a un informe de artículos que faltan antes de liquidar el pedido; una tienda que liquida antes, o que rechaza injustamente, responde ante sus reseñas.",
    `Una tienda podría negarse a hacer el check-in de un repartidor y después quedarse con su garantía si se va y no viene otro. La red no puede distinguir una tienda que no hace el check-in de un repartidor que nunca llegó, así que se pone del lado de la tienda, la parte que más tiene que perder. Los repartidores pueden informar de ello; los informes de repartidores que han entregado para al menos ${t.min_reporter_stores} tiendas distintas aparecen en el historial de la tienda, y las apps de los repartidores pueden evitar las tiendas señaladas.`,
    "Los saldos son créditos emitidos por los emisores de esta red. Lo que vale un saldo fuera de Relay depende de esos emisores, no de Relay.",
    "Si pierdes el teléfono sin haber configurado una frase de recuperación ni guardianes, nadie puede recuperar tu cuenta ni su saldo. Un teléfono que encuentre otra persona aún puede gastar hasta que recuperes la cuenta.",
    "Todo lo que publicas es permanente y se copia por toda la red. Las reseñas, valoraciones y registros de pedidos no se pueden borrar.",
    "Es público a qué tienda pidió una clave de cliente, y aproximadamente dónde. Usar una sola identidad para todo vincula esos pedidos entre sí.",
    "Las reseñas no pueden detectar que una tienda se compre a sí misma con otra identidad para valorarse.",
    "Algunos plazos (tiempos de respuesta de las tiendas, plazos de informes, pedidos programados, caducidad de promociones) dependen de relojes que controlan las personas, y se cree a la tienda en sus propias horas. Las reglas de arriba limitan el daño, pero no pueden eliminarlo del todo. Declarar que una tienda se retrasa, y que un repartidor se va, se demuestran con la fuente pública de tiempo.",
    "El software se ofrece tal cual, sin garantía. Revisa tu pedido antes de confirmarlo, y mantén seguros tu dispositivo y tu identidad.",
  ];
}

export const es: PolicyContent = { changes, sections, risks };
