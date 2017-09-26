import React from 'react';
import { render as reactRender, unmountComponentAtNode } from 'react-dom';
import { batchActions } from 'redux-batched-actions';
import { Provider } from 'react-redux';
import '../stylesheets/main.less';
import Raven from 'raven-js';

import { store } from './store';

import * as authActions from './actions/auth';
import * as userActions from './actions/user';
import { updateText } from './actions/ui';
import { setCurrentLocation } from './actions/browser';
import { sendMessage as _sendMessage, disconnectFaye, fetchUserConversation } from './actions/conversation';
import * as appStateActions from './actions/app-state';
import { setConfig, fetchConfig } from './actions/config';
import { reset } from './actions/common';

import { observable, observeStore } from './utils/events';
import { waitForPage, monitorBrowserState, stopMonitoringBrowserState, updateHostClassNames } from './utils/dom';
import { isImageUploadSupported } from './utils/media';
import { playNotificationSound, isAudioSupported } from './utils/sound';
import * as storage from './utils/storage';
import { getLegacyClientId, upgradeLegacyClientId } from './utils/client';

import { WIDGET_STATE } from './constants/app';

import Widget from './components/Widget';

let lastTriggeredMessageTimestamp = 0;
let initialStoreChange = true;
let unsubscribeFromStore;

// Listen for media query changes from the host page.
window.addEventListener('message', ({data, origin}) => {
    if (origin === `${parent.document.location.protocol}//${parent.document.location.host}`) {
        if (data.type === 'sizeChange') {
            store.dispatch(appStateActions.updateWidgetSize(data.value));
        }
    }
}, false);

function renderWidget() {
    waitForPage().then(() => {
        const mount = document.querySelector('#mount');
        reactRender(<Provider store={ store }>
                        <Widget />
                    </Provider>, mount);
    });
}

observable.on('message:sent', (message) => {
    observable.trigger('message', message);
});
observable.on('message:received', (message) => {
    observable.trigger('message', message);
});

function handleNotificationSound() {
    const {appState: {soundNotificationEnabled}, browser: {hasFocus}} = store.getState();

    if (soundNotificationEnabled && !hasFocus) {
        playNotificationSound();
    }
}

function onStoreChange(props, previousProps) {
    const {conversation: {messages, unreadCount}, widgetState, displayStyle} = props;
    const {conversation: {unreadCount:previousUnreadCount}, widgetState: previousWidgetState, displayStyle: previousDisplayStyle} = previousProps;

    if (messages.length > 0) {
        if (unreadCount > 0 && unreadCount !== previousUnreadCount) {
            // only handle non-user messages
            const filteredMessages = messages.filter((message) => message.role !== 'appUser');
            filteredMessages.slice(-unreadCount).filter((message) => message.received > lastTriggeredMessageTimestamp).forEach((message) => {
                observable.trigger('message:received', message);
                lastTriggeredMessageTimestamp = message.received;

                if (!initialStoreChange) {
                    handleNotificationSound();
                }
            });
        }
        observable.trigger('unreadCount', unreadCount);
    }

    if (widgetState !== previousWidgetState || displayStyle !== previousDisplayStyle) {
        updateHostClassNames(widgetState, displayStyle);
    }

    initialStoreChange = false;

}

function cleanUp() {
    unmountComponentAtNode(document.querySelector('#mount'));
    store.dispatch(disconnectFaye());
    stopMonitoringBrowserState();
    unsubscribeFromStore();
    store.dispatch(reset());
}

function checkInitialization() {
    const {appState: {isInitialized}} = store.getState();
    if (!isInitialized) {
        throw new Error('Must initialize the Web Messenger first using `init()`.');
    }
}

export function on(...args) {
    return observable.on(...args);
}

export function off(...args) {
    return observable.off(...args);
}

export function init(props = {}) {
    const {appState: {isInitialized}} = store.getState();

    if (isInitialized) {
        return Promise.reject(new Error('Web Messenger is already initialized. Call `destroy()` first before calling `init()` again.'));
    }

    if (!props.appId) {
        return Promise.reject(new Error('Must provide an appId'));
    }

    lastTriggeredMessageTimestamp = 0;
    initialStoreChange = true;

    props = {
        imageUploadEnabled: true,
        soundNotificationEnabled: true,
        ...props
    };

    Raven.setExtraContext({
        appId: props.appId
    });

    let sessionToken = storage.getItem(`${props.appId}.sessionToken`);
    let appUserId = storage.getItem(`${props.appId}.appUserId`);

    const actions = [
        appStateActions.setInitializationState(true),
        appStateActions.setEmbedded(!!props.embedded),
        setCurrentLocation(parent.document.location),
        setConfig('appId', props.appId),
        setConfig('soundNotificationEnabled', props.soundNotificationEnabled && isAudioSupported()),
        setConfig('imageUploadEnabled', props.imageUploadEnabled && isImageUploadSupported()),
        setConfig('configBaseUrl', props.configBaseUrl || `https://${props.appId}.config.smooch.io/sdk/`)
    ];

    if (appUserId) {
        actions.push(userActions.setUser({
            _id: appUserId
        }));
    }

    if (sessionToken) {
        actions.push(authActions.setAuth({
            sessionToken
        }));
    }

    if (props.customText) {
        actions.push(updateText(props.customText));
    }

    store.dispatch(batchActions(actions));

    unsubscribeFromStore = observeStore(store, ({config: {appId}, conversation, appState: {widgetState}, config: {style}, browser: {currentLocation}}) => {
        return {
            conversation,
            widgetState,
            displayStyle: style && style.displayStyle,
            currentLocation,
            appId
        };
    }, onStoreChange);

    monitorBrowserState(store.dispatch.bind(store));

    return store.dispatch(fetchConfig())
        .then(() => {
            const {config: {app: {status}}} = store.getState();

            if (status !== 'active') {
                throw new Error('App is inactive.');
            }

            return Promise.resolve()
                .then(() => {
                    const legacyClientId = getLegacyClientId();
                    if (legacyClientId) {
                        return store.dispatch(authActions.upgradeUser(legacyClientId))
                            .catch(() => {
                                // swallow errors
                            })
                            .then((user) => {
                                upgradeLegacyClientId(props.appId);

                                if (user) {
                                    appUserId = user._id;
                                    sessionToken = user.sessionToken;
                                    storage.setItem(`${props.appId}.sessionToken`, sessionToken);

                                    store.dispatch(batchActions([
                                        userActions.setUser({
                                            _id: appUserId
                                        }),
                                        authActions.setAuth({
                                            sessionToken
                                        })
                                    ]));
                                }
                            });
                    }
                })
                .then(() => {
                    if (props.userId && props.jwt) {
                        return login(props.userId, props.jwt);
                    } else if (props.userId || props.jwt) {
                        throw new Error('Must provide a userId and a JWT in order to use the authenticated mode.');
                    }

                    if (appUserId && sessionToken) {
                        return store.dispatch(fetchUserConversation())
                            .catch((err) => {
                                const statusCode = err.response && err.response.status;
                                if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
                                    storage.removeItem(`${props.appId}.appUserId`);
                                    storage.removeItem(`${props.appId}.sessionToken`);

                                    return store.dispatch(batchActions([
                                        authActions.resetAuth(),
                                        userActions.resetUser()
                                    ]));
                                } else {
                                    throw err;
                                }
                            });
                    }
                })
                .then(() => {
                    if (!props.embedded) {
                        render();
                    }

                    observable.trigger('ready');
                });
        })
        .catch((err) => {
            Raven.captureException(err);
            cleanUp();
            throw err;
        });
}

export function login(userId, jwt) {
    return Promise.resolve()
        .then(() => checkInitialization())
        .then(() => {
            if (!userId || !jwt) {
                return Promise.reject(new Error('Must provide a userId and a jwt to log in.'));
            }

            return store.dispatch(authActions.login(userId, jwt));
        });
}

export function logout() {
    return Promise.resolve()
        .then(() => checkInitialization())
        .then(() => store.dispatch(authActions.logout()));
}

export function sendMessage(props) {
    return Promise.resolve()
        .then(() => checkInitialization())
        .then(() => store.dispatch(_sendMessage(props)));
}

export function updateUser(props) {
    return Promise.resolve()
        .then(() => checkInitialization())
        .then(() => store.dispatch(userActions.update(props)));
}

export function getConversation() {
    checkInitialization();
    return store.getState().conversation;
}

export function getUser() {
    const {user} = store.getState();
    return Object.keys(user).length > 0 ? user : undefined;
}

export function destroy() {
    // `destroy()` only need to clean up handlers
    // the rest will be cleaned up with the iframe removal
    const {appState: {isInitialized}} = store.getState();
    if (!isInitialized) {
        return;
    }

    cleanUp();
    observable.trigger('destroy');
    observable.off();
}

export function open() {
    checkInitialization();
    store.dispatch(appStateActions.openWidget());
}

export function close() {
    checkInitialization();
    store.dispatch(appStateActions.closeWidget());
}

export function isOpened() {
    return store.getState().appState.widgetState === WIDGET_STATE.OPENED;
}

export function render() {
    checkInitialization();
    return renderWidget();
}