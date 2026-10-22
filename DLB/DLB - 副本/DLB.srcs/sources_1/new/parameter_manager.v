//////////////////////////////////////////////////////////////////////////////////
// Module Name: parameter_manager
//
// 功能：
//   保存并管理 PC 可以修改的 FPGA 参数
//
// 当前支持：
//
//      ID 0x10 -> Kp
//      ID 0x11 -> Ki
//      ID 0x12 -> Kd
//
// 三者数据格式：
//
//      Q16.16
//
// ============================================================================
// 输入来自 protocol_rx：
//
//      set_valid
//      set_param_id
//      set_param_type
//      set_param_value
//
// ============================================================================
// 输出：
//
//      kp
//      ki
//      kd
//
// 这些输出应该同时连接到：
//
//      1. PID模块
//
//      2. telemetry_param_mux
//
// 从而实现：
//
// PC设置参数
//      ↓
// parameter_manager更新
//      ↓
// PID使用新参数
//      ↓
// telemetry重新上传新参数
//      ↓
// PC确认FPGA实际已经更新
//
// ============================================================================
// 参数默认值：
//
// KP_INIT
// KI_INIT
// KD_INIT
//
// 注意：
// 默认值本身也是Q16.16 RAW值。
//////////////////////////////////////////////////////////////////////////////////

module parameter_manager
#(

    parameter signed [31:0] KP_INIT = 32'sd0,

    parameter signed [31:0] KI_INIT = 32'sd0,

    parameter signed [31:0] KD_INIT = 32'sd0,

    parameter [7:0] ID_KP = 8'h10,

    parameter [7:0] ID_KI = 8'h11,

    parameter [7:0] ID_KD = 8'h12

)
(

    input wire clk,

    input wire rst_n,


    // ============================================================
    // 来自 protocol_rx
    // ============================================================

    input wire        set_valid,

    input wire [7:0]  set_param_id,

    input wire [7:0]  set_param_type,

    input wire [31:0] set_param_value,


    // ============================================================
    // PID参数输出
    // ============================================================

    output reg signed [31:0] kp,

    output reg signed [31:0] ki,

    output reg signed [31:0] kd,


    // ============================================================
    // 调试状态
    // ============================================================

    output reg update_done,

    output reg type_error,

    output reg id_error

);


    // ============================================================
    // DATA TYPE
    // ============================================================

    localparam [7:0] TYPE_Q16_16 = 8'h03;


    // ============================================================
    // PARAM ID
    //
    // 必须与 telemetry_param_mux 保持一致
    // ============================================================

    // ID由实例参数指定；角度环10/11/12，位置环20/21/22。


    // ============================================================
    // Parameter Manager
    // ============================================================

    always @(posedge clk or negedge rst_n)
    begin

        if (!rst_n)
        begin

            // 默认参数

            kp <= KP_INIT;

            ki <= KI_INIT;

            kd <= KD_INIT;


            update_done <= 1'b0;

            type_error <= 1'b0;

            id_error <= 1'b0;

        end


        else
        begin

            // ====================================================
            // 状态脉冲默认清零
            // ====================================================

            update_done <= 1'b0;

            type_error <= 1'b0;

            id_error <= 1'b0;


            // ====================================================
            // 收到有效SET_PARAM
            // ====================================================

            if (set_valid)
            begin

                case (set_param_id)


                    // =================================================
                    // Kp
                    // =================================================

                    ID_KP:
                    begin

                        if (
                            set_param_type
                            ==
                            TYPE_Q16_16
                        )
                        begin

                            kp <= set_param_value;


                            update_done
                                <= 1'b1;

                        end


                        else
                        begin

                            type_error
                                <= 1'b1;

                        end

                    end


                    // =================================================
                    // Ki
                    // =================================================

                    ID_KI:
                    begin

                        if (
                            set_param_type
                            ==
                            TYPE_Q16_16
                        )
                        begin

                            ki <= set_param_value;


                            update_done
                                <= 1'b1;

                        end


                        else
                        begin

                            type_error
                                <= 1'b1;

                        end

                    end


                    // =================================================
                    // Kd
                    // =================================================

                    ID_KD:
                    begin

                        if (
                            set_param_type
                            ==
                            TYPE_Q16_16
                        )
                        begin

                            kd <= set_param_value;


                            update_done
                                <= 1'b1;

                        end


                        else
                        begin

                            type_error
                                <= 1'b1;

                        end

                    end


                    // =================================================
                    // 未定义ID
                    // =================================================

                    default:
                    begin

                        id_error
                            <= 1'b1;

                    end


                endcase

            end

        end

    end


endmodule
