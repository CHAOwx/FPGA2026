//////////////////////////////////////////////////////////////////////////////////
// Module Name: protocol_rx
//
// FPGA UART Protocol V1 Receiver
//
// 当前只实现：
//      PC -> FPGA
//      SET_PARAM
//
// ============================================================================
// SET_PARAM Frame
//
// HEADER:
//
//      A5 5A
//
// VER:
//
//      01
//
// MSG_TYPE:
//
//      10
//
// SEQ:
//
//      2 Byte Little Endian
//
// PAYLOAD_LEN:
//
//      06 00
//
// PAYLOAD:
//
//      PARAM_ID        1 Byte
//      DATA_TYPE       1 Byte
//      VALUE           4 Byte Little Endian
//
// CRC:
//
//      CRC16 / MODBUS
//      Polynomial = 0xA001
//      Initial    = 0xFFFF
//
// CRC计算区域：
//
//      VER
//      MSG_TYPE
//      SEQ
//      PAYLOAD_LEN
//      PAYLOAD
//
// HEADER不参与CRC。
//
// ============================================================================
// 接收成功输出：
//
//      set_valid       = 1clk
//
//      set_param_id
//      set_param_type
//      set_param_value
//
// ============================================================================
// 调试输出：
//
//      crc_error
//          CRC错误时产生1clk脉冲
//
//      format_error
//          版本、TYPE、LEN错误时产生1clk脉冲
//
//      last_seq
//          最近一次成功接收到的SEQ
//
//////////////////////////////////////////////////////////////////////////////////

module protocol_rx(

    input wire clk,

    input wire rst_n,


    // ============================================================
    // UART
    // ============================================================

    input wire uart_rx,

    input wire [2:0] baud_set,


    // ============================================================
    // SET_PARAM 输出
    // ============================================================

    output reg        set_valid,

    output reg [7:0]  set_param_id,

    output reg [7:0]  set_param_type,

    output reg [31:0] set_param_value,


    // ============================================================
    // 调试状态
    // ============================================================

    output reg        crc_error,

    output reg        format_error,

    output reg [15:0] last_seq

);


    // ============================================================
    // Protocol Constants
    // ============================================================

    localparam [7:0] HEADER_0 = 8'hA5;

    localparam [7:0] HEADER_1 = 8'h5A;


    localparam [7:0] PROTOCOL_VER = 8'h01;


    localparam [7:0] MSG_SET_PARAM = 8'h10;


    // SET_PARAM固定Payload：
    //
    // ID     1B
    // TYPE   1B
    // VALUE  4B
    //
    // 共6B

    localparam [15:0] SET_PAYLOAD_LEN = 16'd6;


    // ============================================================
    // UART Byte Receiver
    // ============================================================

    wire [7:0] rx_byte;

    wire rx_byte_done;


    uart_byte_rx u_uart_byte_rx
    (

        .clk
        (
            clk
        ),

        .rst_n
        (
            rst_n
        ),


        .baud_set
        (
            baud_set
        ),

        .uart_rx
        (
            uart_rx
        ),


        .data_byte
        (
            rx_byte
        ),

        .rx_Done
        (
            rx_byte_done
        )

    );


    // ============================================================
    // Protocol State
    // ============================================================

    localparam [3:0]

        S_WAIT_A5 = 4'd0,

        S_WAIT_5A = 4'd1,

        S_VER     = 4'd2,

        S_TYPE    = 4'd3,

        S_SEQ_L   = 4'd4,

        S_SEQ_H   = 4'd5,

        S_LEN_L   = 4'd6,

        S_LEN_H   = 4'd7,

        S_PAYLOAD = 4'd8,

        S_CRC_L   = 4'd9,

        S_CRC_H   = 4'd10;


    reg [3:0] state;


    // ============================================================
    // Frame临时数据
    // ============================================================

    reg [15:0] seq_reg;


    reg [15:0] payload_len_reg;


    reg [2:0] payload_index;


    // ============================================================
    // SET_PARAM临时数据
    // ============================================================

    reg [7:0] param_id_reg;

    reg [7:0] param_type_reg;

    reg [31:0] param_value_reg;


    // ============================================================
    // CRC
    // ============================================================

    reg [15:0] crc_reg;

    reg [15:0] rx_crc_reg;


    // ============================================================
    // CRC16 / MODBUS
    // ============================================================

    function [15:0] crc16_modbus_update;

        input [15:0] crc_in;

        input [7:0] data_in;


        integer i;

        reg [15:0] crc_tmp;


        begin

            crc_tmp =
                crc_in
                ^
                {8'h00, data_in};


            for (
                i = 0;
                i < 8;
                i = i + 1
            )
            begin

                if (crc_tmp[0])
                begin

                    crc_tmp =
                        (crc_tmp >> 1)
                        ^
                        16'hA001;

                end

                else
                begin

                    crc_tmp =
                        crc_tmp >> 1;

                end

            end


            crc16_modbus_update =
                crc_tmp;

        end

    endfunction


    // ============================================================
    // Protocol Receiver FSM
    // ============================================================

    always @(posedge clk or negedge rst_n)
    begin

        if (!rst_n)
        begin

            state <= S_WAIT_A5;


            crc_reg <= 16'hFFFF;

            rx_crc_reg <= 16'h0000;


            seq_reg <= 16'h0000;

            payload_len_reg <= 16'h0000;

            payload_index <= 3'd0;


            param_id_reg <= 8'h00;

            param_type_reg <= 8'h00;

            param_value_reg <= 32'h0000_0000;


            set_valid <= 1'b0;

            set_param_id <= 8'h00;

            set_param_type <= 8'h00;

            set_param_value <= 32'h0000_0000;


            crc_error <= 1'b0;

            format_error <= 1'b0;


            last_seq <= 16'h0000;

        end


        else
        begin

            // ====================================================
            // 默认脉冲输出
            // ====================================================

            set_valid <= 1'b0;

            crc_error <= 1'b0;

            format_error <= 1'b0;


            // ====================================================
            // 收到一个完整UART Byte
            // ====================================================

            if (rx_byte_done)
            begin

                case (state)


                    // =================================================
                    // 等待 A5
                    // =================================================

                    S_WAIT_A5:
                    begin

                        if (rx_byte == HEADER_0)
                        begin

                            state <= S_WAIT_5A;

                        end

                    end


                    // =================================================
                    // 等待 5A
                    // =================================================

                    S_WAIT_5A:
                    begin

                        if (rx_byte == HEADER_1)
                        begin

                            // 找到完整帧头
                            //
                            // 从VER开始计算CRC

                            crc_reg <= 16'hFFFF;

                            state <= S_VER;

                        end


                        // 如果连续出现：
                        //
                        // A5 A5 5A
                        //
                        // 第二个A5可以继续作为新的帧头起点

                        else if (rx_byte == HEADER_0)
                        begin

                            state <= S_WAIT_5A;

                        end


                        else
                        begin

                            state <= S_WAIT_A5;

                        end

                    end


                    // =================================================
                    // Version
                    // =================================================

                    S_VER:
                    begin

                        if (rx_byte == PROTOCOL_VER)
                        begin

                            crc_reg <=
                                crc16_modbus_update
                                (
                                    crc_reg,
                                    rx_byte
                                );


                            state <= S_TYPE;

                        end


                        else
                        begin

                            format_error <= 1'b1;

                            state <= S_WAIT_A5;

                        end

                    end


                    // =================================================
                    // MSG_TYPE
                    //
                    // 当前RX只接受：
                    //
                    // 0x10 SET_PARAM
                    // =================================================

                    S_TYPE:
                    begin

                        if (rx_byte == MSG_SET_PARAM)
                        begin

                            crc_reg <=
                                crc16_modbus_update
                                (
                                    crc_reg,
                                    rx_byte
                                );


                            state <= S_SEQ_L;

                        end


                        else
                        begin

                            format_error <= 1'b1;

                            state <= S_WAIT_A5;

                        end

                    end


                    // =================================================
                    // Sequence Low
                    // =================================================

                    S_SEQ_L:
                    begin

                        seq_reg[7:0] <= rx_byte;


                        crc_reg <=
                            crc16_modbus_update
                            (
                                crc_reg,
                                rx_byte
                            );


                        state <= S_SEQ_H;

                    end


                    // =================================================
                    // Sequence High
                    // =================================================

                    S_SEQ_H:
                    begin

                        seq_reg[15:8] <= rx_byte;


                        crc_reg <=
                            crc16_modbus_update
                            (
                                crc_reg,
                                rx_byte
                            );


                        state <= S_LEN_L;

                    end


                    // =================================================
                    // Payload Length Low
                    // =================================================

                    S_LEN_L:
                    begin

                        payload_len_reg[7:0]
                            <= rx_byte;


                        crc_reg <=
                            crc16_modbus_update
                            (
                                crc_reg,
                                rx_byte
                            );


                        state <= S_LEN_H;

                    end


                    // =================================================
                    // Payload Length High
                    // =================================================

                    S_LEN_H:
                    begin

                        payload_len_reg[15:8]
                            <= rx_byte;


                        crc_reg <=
                            crc16_modbus_update
                            (
                                crc_reg,
                                rx_byte
                            );


                        // SET_PARAM必须严格为6 Byte

                        if (
                            {
                                rx_byte,
                                payload_len_reg[7:0]
                            }
                            ==
                            SET_PAYLOAD_LEN
                        )
                        begin

                            payload_index <= 3'd0;

                            state <= S_PAYLOAD;

                        end


                        else
                        begin

                            format_error <= 1'b1;

                            state <= S_WAIT_A5;

                        end

                    end


                    // =================================================
                    // Payload
                    //
                    // Byte 0 = PARAM_ID
                    //
                    // Byte 1 = DATA_TYPE
                    //
                    // Byte 2 = VALUE[7:0]
                    //
                    // Byte 3 = VALUE[15:8]
                    //
                    // Byte 4 = VALUE[23:16]
                    //
                    // Byte 5 = VALUE[31:24]
                    // =================================================

                    S_PAYLOAD:
                    begin

                        crc_reg <=
                            crc16_modbus_update
                            (
                                crc_reg,
                                rx_byte
                            );


                        case (payload_index)


                            3'd0:
                            begin

                                param_id_reg
                                    <= rx_byte;

                            end


                            3'd1:
                            begin

                                param_type_reg
                                    <= rx_byte;

                            end


                            3'd2:
                            begin

                                param_value_reg[7:0]
                                    <= rx_byte;

                            end


                            3'd3:
                            begin

                                param_value_reg[15:8]
                                    <= rx_byte;

                            end


                            3'd4:
                            begin

                                param_value_reg[23:16]
                                    <= rx_byte;

                            end


                            3'd5:
                            begin

                                param_value_reg[31:24]
                                    <= rx_byte;

                            end


                            default:
                            begin

                            end


                        endcase


                        // 最后一个Payload Byte

                        if (payload_index == 3'd5)
                        begin

                            state <= S_CRC_L;

                        end


                        else
                        begin

                            payload_index
                                <= payload_index + 3'd1;

                        end

                    end


                    // =================================================
                    // CRC Low
                    // =================================================

                    S_CRC_L:
                    begin

                        rx_crc_reg[7:0]
                            <= rx_byte;


                        state <= S_CRC_H;

                    end


                    // =================================================
                    // CRC High
                    // =================================================

                    S_CRC_H:
                    begin

                        rx_crc_reg[15:8]
                            <= rx_byte;


                        // =============================================
                        // CRC正确
                        // =============================================

                        if (
                            {
                                rx_byte,
                                rx_crc_reg[7:0]
                            }
                            ==
                            crc_reg
                        )
                        begin

                            // 输出完整SET_PARAM

                            set_param_id
                                <= param_id_reg;


                            set_param_type
                                <= param_type_reg;


                            set_param_value
                                <= param_value_reg;


                            // 有效脉冲
                            set_valid
                                <= 1'b1;


                            // 记录成功SEQ
                            last_seq
                                <= seq_reg;

                        end


                        // =============================================
                        // CRC错误
                        // =============================================

                        else
                        begin

                            crc_error
                                <= 1'b1;

                        end


                        // 无论成功失败
                        // 都重新等待下一帧

                        state <= S_WAIT_A5;

                    end


                    // =================================================

                    default:
                    begin

                        state <= S_WAIT_A5;

                    end


                endcase

            end

        end

    end


endmodule