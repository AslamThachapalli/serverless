const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineString } = require('firebase-functions/params');

initializeApp();

const shipAccessEmail = defineString("SHIP_ACCESS_EMAIL", {
    description: "Enter the access email for authenticating shiprocket api",
    input: {
        text: {
            validationRegex: /^[\w\.-]+@[a-zA-Z\d\.-]+\.[a-zA-Z]{2,}$/,
            validationErrorMessage: "Enter a valid email address"
        }
    }
})

const shipAccessPassword = defineString("SHIP_ACCESS_PASSWORD", {
    description: "Enter the access password for authenticating shiprocket api"
})

function formatDate(timestamp) {
    const date = new Date(timestamp);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const day = String(date.getDate()).padStart(2, '0');

    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getStatus(payHook) {
    switch(payHook) {
        case ("payment.failed"): {
            return "failed"
        }
        case ("payment.captured"): {
            return "paid"
        }
        case ("refund.created"): {
            return "refund initiated"
        }
        case ("refund.processed"): {
            return "refunded"
        }
        case ("refund.failed"): {
            return "refund failed"
        }
    }
}

exports.updatePaymentStatus = onRequest(async (req, res) => {
    const body = req.body
    const paymentEntity = body.payload.payment.entity

    const toUpdate = {
        paymentId: paymentEntity.id,
        status: getStatus(body.event),
        updatedAt: Date.now(),
    }

    const firestore = getFirestore()
    const orderRef = firestore.collection("orders").doc(paymentEntity.notes.receiptId)
    await orderRef.update(toUpdate)

    res.status(200).end()
})

// todo: Handle webhook order descrepency
exports.updateRefundStatus = onRequest(async (req, res) => {
    const body = req.body
    const refundEntity = body.payload.refund.entity
    const paymentEntity = body.payload.payment.entity

    const toUpdate = {
        status: getStatus(body.event),
        refundId: refundEntity.id,
        updatedAt: Date.now(),
    }
    
    const firestore = getFirestore()
    const orderRef = firestore.collection("orders").doc(paymentEntity.notes.receiptId)
    await orderRef.set(toUpdate, {merge: true})

    res.status(200).end()
})

exports.placeDeliveryOrder = onDocumentUpdated("/orders/{docId}", async (event) => {
    const firestore = getFirestore()

    logger.log("placeDeliveryOrder")

    // Grab the current value of what was updated to Firestore.
    const data = event.data.after.data();

    if(data.status != 'paid'){
        return;
    }

    const { addressId, userId, updatedAt } = data;

    logger.log("updatedAt", updatedAt)

    const [addressSnap, userSnap, orderItemsSnap] = await Promise.all([
        firestore.collection('addresses').doc(addressId).get(),
        firestore.collection('users').doc(userId).get(),
        firestore.collection('orders').doc(data.id).collection("orderItems").get(),
    ])

    const address = addressSnap.data()
    const user = userSnap.data()

    logger.log("address", JSON.stringify(address))
    logger.log("user", JSON.stringify(user))

    const orderItems = orderItemsSnap.docs.map(doc => doc.data());
    const productIds = orderItems.map(item => item.productId);

    logger.log("ProductIds", productIds)

    const productsSnap = await firestore
        .collection("products")
        .where("__name__", "in", productIds)
        .get()

    const products = productsSnap.docs.map(doc => doc.data())

    logger.log("products", JSON.stringify(products))

    const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
        method: "POST",
        body: JSON.stringify({
            "email": shipAccessEmail.value(),
            "password": shipAccessPassword.value(),
        }),
        headers: {
            "content-type": "application/json"
        }
    })

    const token = (await res.json()).token
    logger.info(`authToken for shiprocket is ${token}`)

    var myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append("Authorization", `Bearer ${token}`);

    var raw = JSON.stringify({
        "order_id": data.id,
        "order_date": formatDate(updatedAt),
        "pickup_location": "Primary",
        "channel_id": "",
        "comment": "Reseller: RHIT",
        "billing_customer_name": address.name,
        "billing_last_name": "",
        "billing_address": address.address,
        // "billing_address_2": "Near Hokage House",
        "billing_city": address.city,
        "billing_pincode": address.pincode,
        "billing_state": address.state,
        "billing_country": "India",
        "billing_email": address.email,
        "billing_phone": address.phone,
        "shipping_is_billing": true,
        "shipping_customer_name": "",
        "shipping_last_name": "",
        "shipping_address": "",
        "shipping_address_2": "",
        "shipping_city": "",
        "shipping_pincode": "",
        "shipping_country": "",
        "shipping_state": "",
        "shipping_email": "",
        "shipping_phone": "",
        "order_items": products.map((product) => ({
            "name": product.name,
            "sku": product.id,
            "units": orderItems.find(item => product.id == item.productId).quantity,
            "selling_price": product.price,
            "tax": "",
            "hsn": product.hsn || "",
        })),
        "payment_method": "Prepaid",
        "shipping_charges": 0,
        "giftwrap_charges": 0,
        "transaction_charges": 0,
        "total_discount": 0,
        "sub_total": data.totalAmount,
        "length": 10,
        "breadth": 15,
        "height": 20,
        "weight": 2.5
    });

    var requestOptions = {
        method: 'POST',
        headers: myHeaders,
        body: raw,
        redirect: 'follow'
    };

    const orderRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", requestOptions);
    const orderData = await orderRes.json()

    logger.log(`shiprocker respose stringified: ${JSON.stringify(orderData)}`);

    // You must return a Promise when performing
    // asynchronous tasks inside a function
    // such as writing to Firestore.
    return event.data.ref.set({
        deliveryId: orderData.order_id,
        shipmentId: orderData.shipment_id,
        updatedAt: Date.now(),
    }, { merge: true });
});