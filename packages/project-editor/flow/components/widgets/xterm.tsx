import React from "react";

import {
    registerClass,
    makeDerivedClassInfo,
    ProjectType
} from "project-editor/core/object";

import { ComponentOutput, Widget } from "project-editor/flow/component";
import { IFlowContext } from "project-editor/flow/flow-interfaces";
import { addCssStylesheet } from "eez-studio-shared/dom";
import { FlowState } from "project-editor/flow/runtime";
import { observer } from "mobx-react";

////////////////////////////////////////////////////////////////////////////////

class RunningState {
    onData: ((value: string) => void) | undefined = undefined;
}

export class TerminalWidget extends Widget {
    static classInfo = makeDerivedClassInfo(Widget.classInfo, {
        properties: [],
        defaultValue: {
            left: 0,
            top: 0,
            width: 240,
            height: 240
        },

        icon: (
            <svg
                viewBox="0 0 24 24"
                strokeWidth="2"
                stroke="currentColor"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M8 9l3 3l-3 3"></path>
                <line x1="13" y1="15" x2="16" y2="15"></line>
                <rect x="3" y="4" width="18" height="16" rx="2"></rect>
            </svg>
        ),

        enabledInComponentPalette: (projectType: ProjectType) =>
            projectType === ProjectType.DASHBOARD
    });

    getOutputs(): ComponentOutput[] {
        return [
            ...super.getOutputs(),
            {
                name: "onData",
                type: "string",
                isOptionalOutput: true,
                isSequenceOutput: false
            }
        ];
    }

    render(flowContext: IFlowContext): React.ReactNode {
        return (
            <>
                <TerminalElement widget={this} flowContext={flowContext} />
                {super.render(flowContext)}
            </>
        );
    }

    async execute(flowState: FlowState) {
        if (!this.data) {
            return undefined;
        }

        let runningState =
            flowState.getComponentRunningState<RunningState>(this);

        if (!runningState) {
            runningState = new RunningState();
            flowState.setComponentRunningState(this, runningState);
        }

        const componentState = flowState.getComponentState(this);
        if (componentState.unreadInputsData.has(this.data)) {
            const value = componentState.inputsData.get(this.data);
            if (
                runningState.onData &&
                value &&
                typeof value === "string" &&
                value.length > 0
            ) {
                runningState.onData(value);
            }
        }

        return undefined;
    }
}

registerClass("TerminalWidget", TerminalWidget);

////////////////////////////////////////////////////////////////////////////////

@observer
class TerminalElement extends React.Component<{
    widget: TerminalWidget;
    flowContext: IFlowContext;
}> {
    ref = React.createRef<HTMLDivElement>();

    terminal: any;
    fitAddon: any;

    dispose: any;

    async componentDidMount() {
        console.log("componentDidMount");
        if (!this.ref.current) {
            return;
        }

        addCssStylesheet("xterm-css", "../../node_modules/xterm/css/xterm.css");

        const { Terminal } = await import("xterm");
        const { FitAddon } = await import("xterm-addon-fit");
        this.terminal = new Terminal();
        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.open(this.ref.current);
        this.terminal.write("$ ");
        this.fitAddon.fit();

        this.terminal.onData((data: string) => {
            this.terminal.write(data);

            if (this.props.flowContext.flowState) {
                this.props.flowContext.flowState.runtime.propagateValue(
                    this.props.flowContext.flowState,
                    this.props.widget,
                    "onData",
                    data
                );
            }
        });

        if (this.props.flowContext.flowState) {
            let runningState =
                this.props.flowContext.flowState.getComponentRunningState<RunningState>(
                    this.props.widget
                );
            if (runningState) {
                runningState.onData = data => {
                    this.terminal.write(data);
                };
            }
        }
    }

    componentDidUpdate() {
        if (this.fitAddon) {
            this.fitAddon.fit();
        }
    }

    componentWillUnmount() {
        if (this.dispose) {
            this.dispose();
        }
    }

    render() {
        return (
            <div
                ref={this.ref}
                style={{
                    width: this.props.widget.width,
                    height: this.props.widget.height
                }}
            ></div>
        );
    }
}