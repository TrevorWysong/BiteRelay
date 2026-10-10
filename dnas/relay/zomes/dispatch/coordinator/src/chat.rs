//! Direct messaging between an order's two active parties (customer and
//! the driver who won the bid), once there's an accepted bid to resolve
//! "the other party" from -- exactly the kind of high-frequency exchange
//! the architecture plan's §3 already anticipated: "every subsequent
//! high-frequency exchange... is direct signal traffic, never a DHT
//! commit." Deliberately **not** persisted as an entry: chat is lower-
//! stakes than anything else this app stores durably (payments, disputes,
//! attestations), and Holochain's append-only storage model has no cheap
//! way to let a chat history shrink or expire -- signal-only means no
//! history survives a page reload, which is an honest, named limitation,
//! not an oversight.

use crate::parties::resolve_order_and_bid;
use crate::signals::RemoteSignal;
use hdk::prelude::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct SendChatMessageInput {
    pub order_ref: ActionHash,
    pub text: String,
}

/// Resolves "the other party" from the order's requester and its accepted
/// bid's bidder, then signals them directly -- never a broadcast. Chat is
/// only available once a bid has actually been accepted; there's no third
/// party (the merchant) on this channel, matching the customer-chooses-the-
/// driver design (the merchant's own stake is covered by shared visibility
/// into driver reputation, not a separate channel here either).
#[hdk_extern]
pub fn send_chat_message(input: SendChatMessageInput) -> ExternResult<()> {
    if input.text.trim().is_empty() {
        return Err(wasm_error!(WasmErrorInner::Guest("chat message must not be empty".into())));
    }
    if input.text.chars().count() > relay_integrity_support::limits::MAX_NOTE_CHARS {
        return Err(wasm_error!(WasmErrorInner::Guest(format!("a chat message is at most {} characters", relay_integrity_support::limits::MAX_NOTE_CHARS))));
    }
    let me = agent_info()?.agent_initial_pubkey;
    let (order, bid) = resolve_order_and_bid(input.order_ref.clone(), "chat is only available once a driver has been assigned")?;

    let other = if me == order.requester {
        bid.bidder
    } else if me == bid.bidder {
        order.requester
    } else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only this order's requester or its accepted driver can send chat messages".into()
        )));
    };

    send_remote_signal(
        RemoteSignal::ChatMessage { order_hash: input.order_ref, text: input.text },
        vec![other],
    )
}
