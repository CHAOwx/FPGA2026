//////////////////////////////////////////////////////////////////////////////////
// Module Name: protocol_tx
//
// FPGA UART Protocol V1
//
// 当前版本实现：
//      TELEMETRY 0x01
//
// ============================================================================
// Frame
//
// +--------+-----+----------+------+-------------+---------+-------+
// | HEADER | VER | MSG_TYPE | SEQ  | PAYLOAD_LEN | PAYLOAD | CRC16 |
// +--------+-----+----------+------+-------------+---------+-------+
// |   2B   | 1B  |    1B    | 2B   |     2B      |   NB    |  2B   |
// +--------+-----+----------+------+-------------+---------+-------+
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
//      01 = TELEMETRY
//
// Byte Order:
//
//      Little Endian
//
// CRC:
//
//      CRC-16/MODBUS
//      Polynomial = 0xA001
//      Initial    = 0xFFFF
//
// CRC计算范围：
//
//      VER
//      MSG_TYPE
//      SEQ
//      PAYLOAD_LEN
//      PAYLOAD
//
// HEADER 和 CRC 本身不参与 CRC 计算
//
// ============================================================================
// TELEMETRY Payload
//
// COUNT                      1 Byte
//
// PARAM:
//      PARAM_ID              1 Byte
//      DATA_TYPE             1 Byte
//      VALUE                 4 Byte
//
// 一个参数共：
//
//      6 Byte
//
// PAYLOAD_LEN:
//
//      1 + COUNT * 6
//
// ============================================================================
// 使用方式
//
// 1.
// telemetry_param_mux:
//
//      param_index
//          ↓
//      ID / TYPE / VALUE
//
//
// 2.
// 当 tx_busy == 0：
//
//      send_en 拉高 1 clk
//
//
// 3.
// 自动发送完整 Frame
//
//
// 4.
// 整帧完成：
//
//      tx_done 拉高 1 clk
//
// ============================================================================
//////////////////////////////////////////////////////////////////////////////////

module protocol_tx(
    input             clk,
    input             rst_n,
    // ============================================================
    // Frame 控制
    // ============================================================
    input             send_en,
    input      [2:0]  baud_set,
    // ============================================================
    // Telemetry Parameter MUX
    // ============================================================
    input      [7:0]  param_count,
    output reg [7:0]  param_index,
    input      [7:0]  param_id,
    input      [7:0]  param_type,
    input      [31:0] param_value,
    // ============================================================
    // UART TX
    // ============================================================
    output            uart_tx,
    // ============================================================
    // Frame 状态
    // ============================================================
    output reg        tx_busy,
    output reg        tx_done

);
    // ============================================================
    // Protocol 常量
    // ============================================================
    localparam [7:0] HEADER_0 = 8'hA5;
    localparam [7:0] HEADER_1 = 8'h5A;
    localparam [7:0] PROTOCOL_VER = 8'h01;
    localparam [7:0] MSG_TELEMETRY = 8'h01;
    // ============================================================
    // 状态机
    // ============================================================
    localparam [4:0]
        S_IDLE       = 5'd0,
        S_HEADER_0   = 5'd1,
        S_HEADER_1   = 5'd2,
        S_VER        = 5'd3,
        S_TYPE       = 5'd4,
        S_SEQ_L      = 5'd5,
        S_SEQ_H      = 5'd6,
        S_LEN_L      = 5'd7,
        S_LEN_H      = 5'd8,
        S_COUNT      = 5'd9,
        S_PARAM_LOAD = 5'd10,
        S_PARAM_ID   = 5'd11,
        S_PARAM_TYPE = 5'd12,
        S_VALUE_0    = 5'd13,
        S_VALUE_1    = 5'd14,
        S_VALUE_2    = 5'd15,
        S_VALUE_3    = 5'd16,
        S_CRC_L      = 5'd17,
        S_CRC_H      = 5'd18,
        S_DONE       = 5'd19;
    reg [4:0] state;
    // ============================================================
    // Frame 数据
    // ============================================================
    // 帧序号
    reg [15:0] seq_reg;
    // Payload长度
    reg [15:0] payload_len_reg;
    // 当前帧参数数量
    reg [7:0] param_count_reg;
    // ============================================================
    // 当前参数锁存
    //
    // 非常重要：
    //
    // param_value 可能一直变化。
    //
    // 一个32位数据需要分4个Byte发送，
    // 所以必须在发送该参数之前锁存一次。
    //
    // 否则可能出现：
    //
    // Byte0来自Position=100
    // Byte1来自Position=101
    // Byte2来自Position=102
    //
    // 导致拼接数据错误。
    // ============================================================
    reg [7:0] param_id_reg;
    reg [7:0] param_type_reg;
    reg [31:0] param_value_reg;
    // ============================================================
    // CRC
    // ============================================================
    reg [15:0] crc_reg;
    // ============================================================
    // uart_byte_tx
    // ============================================================
    reg [7:0] byte_data;
    reg byte_send_en;
    wire byte_tx_done;
    wire byte_uart_state;
    uart_byte_tx u_uart_byte_tx(

        .clk        (clk),

        .rst_n      (rst_n),


        .data_byte  (byte_data),

        .send_en    (byte_send_en),

        .baud_set   (baud_set),


        .uart_tx    (uart_tx),

        .tx_done    (byte_tx_done),

        .uart_state (byte_uart_state)

    );


    // ============================================================
    // byte_wait
    //
    // = 1
    //
    // 表示当前协议Byte已经交给 uart_byte_tx，
    // 正在等待发送完成。
    // ============================================================

    reg byte_wait;


    // ============================================================
    // CRC16 / MODBUS
    //
    // 输入：
    //
    //      crc_in
    //      data_in
    //
    // 输出：
    //
    //      加入当前 Byte 后的新 CRC
    //
    // ============================================================

    function [15:0] crc16_modbus_update;

        input [15:0] crc_in;

        input [7:0] data_in;


        integer i;

        reg [15:0] crc_tmp;


        begin

            crc_tmp = crc_in ^ {8'h00, data_in};


            for (i = 0; i < 8; i = i + 1) begin

                if (crc_tmp[0])

                    crc_tmp =
                        (crc_tmp >> 1) ^ 16'hA001;

                else

                    crc_tmp =
                        crc_tmp >> 1;

            end


            crc16_modbus_update = crc_tmp;

        end

    endfunction


    // ============================================================
    // 主状态机
    // ============================================================

    always @(posedge clk or negedge rst_n) begin


        // ========================================================
        // Reset
        // ========================================================

        if (!rst_n) begin

            state <= S_IDLE;


            seq_reg <= 16'h0000;


            payload_len_reg <= 16'h0000;

            param_count_reg <= 8'h00;


            param_index <= 8'h00;


            param_id_reg <= 8'h00;

            param_type_reg <= 8'h00;

            param_value_reg <= 32'h0000_0000;


            crc_reg <= 16'hFFFF;


            byte_data <= 8'h00;

            byte_send_en <= 1'b0;

            byte_wait <= 1'b0;


            tx_busy <= 1'b0;

            tx_done <= 1'b0;

        end


        // ========================================================
        // Normal
        // ========================================================

        else begin


            // ----------------------------------------------------
            // 默认脉冲信号
            // ----------------------------------------------------

            byte_send_en <= 1'b0;

            tx_done <= 1'b0;


            // ====================================================
            // FSM
            // ====================================================

            case (state)


                // =================================================
                // IDLE
                // =================================================

                S_IDLE:
                begin

                    tx_busy <= 1'b0;

                    byte_wait <= 1'b0;


                    // ---------------------------------------------
                    // 接收到一帧发送请求
                    // ---------------------------------------------

                    if (send_en) begin

                        tx_busy <= 1'b1;


                        // 锁存本次参数数量

                        param_count_reg <= param_count;


                        // 从参数0开始

                        param_index <= 8'd0;


                        // =========================================
                        // Payload Length
                        //
                        // 1 + N * 6
                        //
                        // N * 6
                        // =
                        // N * 4 + N * 2
                        //
                        // 使用移位+加法
                        // =========================================

                        payload_len_reg <=

                            16'd1

                            +

                            ({8'd0, param_count} << 2)

                            +

                            ({8'd0, param_count} << 1);


                        // 初始化 CRC

                        crc_reg <= 16'hFFFF;


                        // 开始发送 Header

                        state <= S_HEADER_0;

                    end

                end


                // =================================================
                // 参数锁存
                //
                // 这里不发送UART
                //
                // param_index已经稳定
                // telemetry_param_mux已经输出对应参数
                //
                // 这里将参数完整锁存
                // =================================================

                S_PARAM_LOAD:
                begin

                    param_id_reg <= param_id;

                    param_type_reg <= param_type;

                    param_value_reg <= param_value;


                    byte_wait <= 1'b0;


                    state <= S_PARAM_ID;

                end


                // =================================================
                // Frame Done
                // =================================================

                S_DONE:
                begin

                    tx_busy <= 1'b0;


                    // 整帧完成脉冲

                    tx_done <= 1'b1;


                    // SEQ自然累加
                    //
                    // FFFF + 1 自动回到0000

                    seq_reg <= seq_reg + 16'd1;


                    byte_wait <= 1'b0;


                    state <= S_IDLE;

                end


                // =================================================
                // 所有真正发送 Byte 的状态
                // =================================================

                default:
                begin


                    // =============================================
                    // PART 1
                    //
                    // 当前Byte还没有开始发送
                    // =============================================

                    if (

                        !byte_wait

                        &&

                        !byte_uart_state

                    )
                    begin


                        // 当前Byte已经交给UART

                        byte_wait <= 1'b1;


                        // 给 uart_byte_tx 一个clk脉冲

                        byte_send_en <= 1'b1;


                        // =========================================
                        // 根据当前协议阶段产生Byte
                        // =========================================

                        case (state)


                            // =====================================
                            // HEADER A5
                            //
                            // Header 不参与 CRC
                            // =====================================

                            S_HEADER_0:
                            begin

                                byte_data <= HEADER_0;

                            end


                            // =====================================
                            // HEADER 5A
                            // =====================================

                            S_HEADER_1:
                            begin

                                byte_data <= HEADER_1;

                            end


                            // =====================================
                            // Version
                            // =====================================

                            S_VER:
                            begin

                                byte_data <= PROTOCOL_VER;


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    PROTOCOL_VER

                                );

                            end


                            // =====================================
                            // MSG_TYPE
                            // =====================================

                            S_TYPE:
                            begin

                                byte_data <= MSG_TELEMETRY;


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    MSG_TELEMETRY

                                );

                            end


                            // =====================================
                            // SEQ Low
                            // =====================================

                            S_SEQ_L:
                            begin

                                byte_data <= seq_reg[7:0];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    seq_reg[7:0]

                                );

                            end


                            // =====================================
                            // SEQ High
                            // =====================================

                            S_SEQ_H:
                            begin

                                byte_data <= seq_reg[15:8];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    seq_reg[15:8]

                                );

                            end


                            // =====================================
                            // Payload Length Low
                            // =====================================

                            S_LEN_L:
                            begin

                                byte_data <= payload_len_reg[7:0];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    payload_len_reg[7:0]

                                );

                            end


                            // =====================================
                            // Payload Length High
                            // =====================================

                            S_LEN_H:
                            begin

                                byte_data <= payload_len_reg[15:8];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    payload_len_reg[15:8]

                                );

                            end


                            // =====================================
                            // Parameter Count
                            // =====================================

                            S_COUNT:
                            begin

                                byte_data <= param_count_reg;


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_count_reg

                                );

                            end


                            // =====================================
                            // PARAM ID
                            // =====================================

                            S_PARAM_ID:
                            begin

                                byte_data <= param_id_reg;


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_id_reg

                                );

                            end


                            // =====================================
                            // PARAM TYPE
                            // =====================================

                            S_PARAM_TYPE:
                            begin

                                byte_data <= param_type_reg;


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_type_reg

                                );

                            end


                            // =====================================
                            // VALUE BYTE 0
                            //
                            // Little Endian
                            // =====================================

                            S_VALUE_0:
                            begin

                                byte_data <=
                                    param_value_reg[7:0];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_value_reg[7:0]

                                );

                            end


                            // =====================================
                            // VALUE BYTE 1
                            // =====================================

                            S_VALUE_1:
                            begin

                                byte_data <=
                                    param_value_reg[15:8];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_value_reg[15:8]

                                );

                            end


                            // =====================================
                            // VALUE BYTE 2
                            // =====================================

                            S_VALUE_2:
                            begin

                                byte_data <=
                                    param_value_reg[23:16];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_value_reg[23:16]

                                );

                            end


                            // =====================================
                            // VALUE BYTE 3
                            // =====================================

                            S_VALUE_3:
                            begin

                                byte_data <=
                                    param_value_reg[31:24];


                                crc_reg <= crc16_modbus_update(

                                    crc_reg,

                                    param_value_reg[31:24]

                                );

                            end


                            // =====================================
                            // CRC Low
                            //
                            // CRC本身不再次参与CRC计算
                            // =====================================

                            S_CRC_L:
                            begin

                                byte_data <= crc_reg[7:0];

                            end


                            // =====================================
                            // CRC High
                            // =====================================

                            S_CRC_H:
                            begin

                                byte_data <= crc_reg[15:8];

                            end


                            // =====================================
                            // Default
                            // =====================================

                            default:
                            begin

                                byte_data <= 8'h00;

                            end


                        endcase

                    end


                    // =============================================
                    // PART 2
                    //
                    // 当前 Byte 已经发送完成
                    //
                    // 推进协议状态
                    // =============================================

                    if (

                        byte_wait

                        &&

                        byte_tx_done

                    )
                    begin


                        byte_wait <= 1'b0;


                        case (state)


                            // =====================================
                            // Header
                            // =====================================

                            S_HEADER_0:
                                state <= S_HEADER_1;


                            S_HEADER_1:
                                state <= S_VER;


                            // =====================================
                            // Version
                            // =====================================

                            S_VER:
                                state <= S_TYPE;


                            // =====================================
                            // Type
                            // =====================================

                            S_TYPE:
                                state <= S_SEQ_L;


                            // =====================================
                            // Sequence
                            // =====================================

                            S_SEQ_L:
                                state <= S_SEQ_H;


                            S_SEQ_H:
                                state <= S_LEN_L;


                            // =====================================
                            // Length
                            // =====================================

                            S_LEN_L:
                                state <= S_LEN_H;


                            S_LEN_H:
                                state <= S_COUNT;


                            // =====================================
                            // COUNT
                            // =====================================

                            S_COUNT:
                            begin

                                // 没有任何参数
                                if (

                                    param_count_reg
                                    ==
                                    8'd0

                                )
                                begin

                                    state <= S_CRC_L;

                                end


                                // 有参数
                                else begin

                                    param_index <= 8'd0;

                                    state <= S_PARAM_LOAD;

                                end

                            end


                            // =====================================
                            // Parameter
                            // =====================================

                            S_PARAM_ID:
                                state <= S_PARAM_TYPE;


                            S_PARAM_TYPE:
                                state <= S_VALUE_0;


                            // =====================================
                            // VALUE
                            // =====================================

                            S_VALUE_0:
                                state <= S_VALUE_1;


                            S_VALUE_1:
                                state <= S_VALUE_2;


                            S_VALUE_2:
                                state <= S_VALUE_3;


                            // =====================================
                            // 当前参数的最后一个 Byte
                            // =====================================

                            S_VALUE_3:
                            begin


                                // ---------------------------------
                                // 后面还有参数
                                // ---------------------------------

                                if (

                                    (param_index + 8'd1)

                                    <

                                    param_count_reg

                                )
                                begin

                                    // 下一个参数

                                    param_index <=
                                        param_index + 8'd1;


                                    // 回到参数锁存阶段

                                    state <= S_PARAM_LOAD;

                                end


                                // ---------------------------------
                                // 所有参数都发送完成
                                // ---------------------------------

                                else begin

                                    state <= S_CRC_L;

                                end

                            end


                            // =====================================
                            // CRC
                            // =====================================

                            S_CRC_L:
                                state <= S_CRC_H;


                            S_CRC_H:
                                state <= S_DONE;


                            // =====================================
                            // Default
                            // =====================================

                            default:
                                state <= S_IDLE;


                        endcase

                    end

                end


            endcase

        end

    end


endmodule