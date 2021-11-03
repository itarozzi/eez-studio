import { observable, toJS, runInAction } from "mobx";

import { watch } from "eez-studio-shared/notify";

import type { InstrumentObject } from "instrument/instrument-object";
import type { ConnectionParameters } from "instrument/connection/interface";
import { ConnectionErrorCode } from "instrument/connection/ConnectionErrorCode";
import type { IFileUploadInstructions } from "instrument/connection/file-upload";
import {
    ConnectionBase,
    ConnectionState,
    ConnectionStatus,
    IConnection,
    ISendOptions
} from "instrument/connection/connection-base";
import { createHistoryItem } from "instrument/window/history/item-factory";
import { activityLogStore } from "eez-studio-shared/activity-log";
import { showConnectionDialog } from "instrument/window/connection-dialog";
import { guid } from "eez-studio-shared/guid";

export class IpcConnection extends ConnectionBase {
    static ipcConnections = new Map<string, IpcConnection>();

    @observable state: ConnectionState = ConnectionState.IDLE;
    @observable errorCode: ConnectionErrorCode = ConnectionErrorCode.NONE;
    @observable error: string | undefined;

    onSuccess?: () => void;
    onError?: (error: any) => void;

    acquireId = guid();

    resolveCallback: ((result: any) => void) | undefined;
    rejectCallback: ((result: any) => void) | undefined;

    acquireQueue: {
        acquireId: string;
        resolve: () => void;
        reject: (reason?: any) => void;
    }[] = [];

    constructor(instrument: InstrumentObject) {
        super(instrument);

        watch(
            "instrument/" + instrument.id + "/connection",
            undefined,
            (connectionStatus: ConnectionStatus) => {
                runInAction(() => {
                    this.state = connectionStatus.state;
                    this.errorCode = connectionStatus.errorCode;
                    this.error = connectionStatus.error;
                });

                if (connectionStatus.state != ConnectionState.CONNECTED) {
                    if (this.rejectCallback) {
                        this.rejectCallback(
                            new Error("Connection disconnected.")
                        );
                        this.rejectCallback = undefined;
                        this.resolveCallback = undefined;
                    }
                }
            }
        );

        IpcConnection.ipcConnections.set(instrument.id, this);
        if (IpcConnection.ipcConnections.size == 1) {
            IpcConnection.setupIpcListeners();
        }
    }

    static setupIpcListeners() {
        EEZStudio.electron.ipcRenderer.on(
            "instrument/connection/long-operation-result",
            (
                event: any,
                args: {
                    instrumentId: string;
                    error?: any;
                }
            ) => {
                const ipcConnection = IpcConnection.ipcConnections.get(
                    args.instrumentId
                );
                if (ipcConnection) {
                    if (args.error) {
                        if (ipcConnection.onError) {
                            ipcConnection.onError(args.error);
                        }
                    } else {
                        if (ipcConnection.onSuccess) {
                            ipcConnection.onSuccess();
                        }
                    }
                    ipcConnection.onError = undefined;
                    ipcConnection.onSuccess = undefined;
                } else {
                    console.error(
                        "Unknown instrument ID for the long operation:",
                        args.instrumentId
                    );
                }
            }
        );

        EEZStudio.electron.ipcRenderer.on(
            "instrument/connection/acquire-result",
            (
                event: any,
                args: {
                    instrumentId: string;
                    acquireId: string;
                    rejectReason?: any;
                }
            ) => {
                const ipcConnection = IpcConnection.ipcConnections.get(
                    args.instrumentId
                );
                if (ipcConnection) {
                    for (
                        let i = 0;
                        i < ipcConnection.acquireQueue.length;
                        i++
                    ) {
                        const acquireTask = ipcConnection.acquireQueue[i];
                        if (acquireTask.acquireId === args.acquireId) {
                            ipcConnection.acquireQueue.splice(i, 1);
                            if (args.rejectReason) {
                                acquireTask.reject(args.rejectReason);
                            } else {
                                acquireTask.resolve();
                            }
                            break;
                        }
                    }
                } else {
                    console.error(
                        "Unknown instrument ID for the acquire result:",
                        args.instrumentId
                    );
                }
            }
        );

        EEZStudio.electron.ipcRenderer.on(
            "instrument/connection/value",
            (
                event: any,
                args: {
                    instrumentId: string;
                    acquireId: string;
                    value: any;
                    error: any;
                }
            ) => {
                const ipcConnection = IpcConnection.ipcConnections.get(
                    args.instrumentId
                );

                if (ipcConnection) {
                    if (ipcConnection.acquireId === args.acquireId) {
                        ipcConnection.onValue(args.value, args.error);
                    }
                } else {
                    console.error(
                        "Unknown instrument ID for the query result:",
                        args.instrumentId
                    );
                }
            }
        );
    }

    dismissError() {
        EEZStudio.electron.ipcRenderer.send(
            "instrument/connection/dismiss-error",
            {
                instrumentId: this.instrument.id
            }
        );
    }

    connect(connectionParameters?: ConnectionParameters) {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/connect", {
            instrumentId: this.instrument.id,
            connectionParameters: toJS(connectionParameters)
        });
    }

    disconnect() {
        EEZStudio.electron.ipcRenderer.send(
            "instrument/connection/disconnect",
            {
                instrumentId: this.instrument.id
            }
        );
    }

    destroy() {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/destroy", {
            instrumentId: this.instrument.id
        });
    }

    send(command: string) {
        let options: ISendOptions | undefined;

        // find out command name, i.e. up to parameters section which start with space
        let commandName;
        let i = command.indexOf(" ");
        if (i !== -1) {
            commandName = command.substr(0, i);
        } else {
            // no parameters
            commandName = command;
        }

        if (commandName.endsWith("?")) {
            // get expected query response
            options = {
                queryResponseType:
                    this.instrument.getQueryResponseType(commandName)
            };
        } else {
            if (this.instrument.isCommandSendsBackDataBlock(commandName)) {
                options = {
                    queryResponseType: "non-standard-data-block"
                };
            }
        }

        EEZStudio.electron.ipcRenderer.send("instrument/connection/send", {
            instrumentId: this.instrument.id,
            command,
            options
        });
    }

    doUpload(
        instructions: IFileUploadInstructions,
        onSuccess?: () => void,
        onError?: (error: any) => void
    ) {
        this.onSuccess = onSuccess;
        this.onError = onError;

        EEZStudio.electron.ipcRenderer.send("instrument/connection/upload", {
            instrumentId: this.instrument.id,
            instructions: toJS(instructions),
            callbackWindowId: EEZStudio.remote.getCurrentWindow().id
        });
    }

    async isLongOperationInProgress() {
        EEZStudio.electron.ipcRenderer.send(
            "instrument/connection/abort-long-operation",
            {
                instrumentId: this.instrument.id
            }
        );
    }

    abortLongOperation() {
        EEZStudio.electron.ipcRenderer.send(
            "instrument/connection/abort-long-operation",
            {
                instrumentId: this.instrument.id
            }
        );
    }

    async doAcquire(
        instrumentId: string,
        acquireId: string,
        callbackWindowId: number,
        traceEnabled: boolean
    ) {
        return new Promise<void>((resolve, reject) => {
            this.acquireQueue.push({
                acquireId,
                resolve,
                reject
            });

            EEZStudio.electron.ipcRenderer.send(
                "instrument/connection/acquire",
                {
                    instrumentId,
                    acquireId,
                    callbackWindowId,
                    traceEnabled
                }
            );
        });
    }

    doRelease() {
        EEZStudio.electron.ipcRenderer.sendSync(
            "instrument/connection/release",
            {
                instrumentId: this.instrument.id
            }
        );
    }

    get interfaceInfo() {
        let connectionParameters = this.instrument.lastConnection;
        if (connectionParameters) {
            return (
                "Connected to " +
                getConnectionParametersInfo(connectionParameters)
            );
        } else {
            return undefined;
        }
    }

    handleConnect = (connectionParameters: ConnectionParameters) => {
        if (!connectionParameters && !this.instrument.lastConnection) {
            connectionParameters = this.instrument.defaultConnectionParameters;
        }
        this.connect(connectionParameters);
    };

    openConnectDialog() {
        showConnectionDialog(
            this.instrument.getConnectionParameters([
                this.instrument.lastConnection,
                this.instrument.defaultConnectionParameters
            ]),
            this.handleConnect,
            this.instrument.availableConnections,
            this.instrument.serialBaudRates
        );
    }

    async acquire(traceEnabled: boolean) {
        await this.doAcquire(
            this.instrument.id,
            this.acquireId,
            EEZStudio.remote.getCurrentWindow().id,
            traceEnabled
        );
    }

    command(command: string) {
        this.send(command);
    }

    query(query: string) {
        return new Promise<any>((resolve, reject) => {
            if (this.isConnected) {
                this.resolveCallback = resolve;
                this.rejectCallback = reject;
                this.send(query);
            } else {
                reject("not connected");
            }
        });
    }

    upload(
        instructions: IFileUploadInstructions,
        onSuccess?: () => void,
        onError?: (error: any) => void
    ) {
        this.doUpload(instructions, onSuccess, onError);
    }

    onValue(value: any, error: any) {
        if (error) {
            if (this.rejectCallback) {
                this.rejectCallback(new Error(error));
            }
        } else {
            if (value.logEntry !== undefined) {
                value = createHistoryItem(activityLogStore, value.logEntry);
            }

            if (this.resolveCallback) {
                this.resolveCallback(value);
            }
        }

        this.rejectCallback = undefined;
        this.resolveCallback = undefined;
    }

    release() {
        this.doRelease();
    }
}

////////////////////////////////////////////////////////////////////////////////

export function getConnectionParametersInfo(
    connectionParameters: ConnectionParameters
) {
    if (!connectionParameters) {
        return "";
    }

    if (connectionParameters.type === "ethernet") {
        return `${connectionParameters.ethernetParameters.address}:${connectionParameters.ethernetParameters.port}`;
    } else if (connectionParameters.type === "serial") {
        return `${connectionParameters.serialParameters.port}:${connectionParameters.serialParameters.baudRate}`;
    } else if (connectionParameters.type === "usbtmc") {
        return `USBTMC`;
    } else {
        return "VISA";
    }
}

////////////////////////////////////////////////////////////////////////////////

export const connections = observable(new Map<string, IConnection>());

export function createRendererProcessConnection(instrument: InstrumentObject) {
    const connection = new IpcConnection(instrument);
    runInAction(() => connections.set(instrument.id.toString(), connection));
    return connection;
}